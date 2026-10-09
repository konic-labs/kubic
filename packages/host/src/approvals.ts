import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type {
  ApprovalAskVerdict,
  ApprovalCall,
  PolicyInterceptorOptions,
} from '@kubic/agent/lane/interceptors';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
  redactReason,
} from '@kubic/agent/lane/interceptors';
import type { ToolContribution } from '@kubic/agent/lane/wrap';
import { withTelemetry } from '@kubic/agent/lane/wrap';
import type { ToolDisplay } from '@kubic/agent/ops/display-diff';
import type {
  CredentialLevel,
  PermissionClasses,
  UnsupportedLevel,
} from '@kubic/agent/permissions';
import {
  checkAgreement,
  checkExpressible,
  effectiveCredentialLevel,
  effectiveNetworkLevel,
  toolsForClasses,
  validateClasses,
} from '@kubic/agent/permissions';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { approvalCommandText, summarizeCommand } from './approval-display.js';
import { approvalPreview } from './approval-preview.js';
import { TIMEOUT_REASON_MARKER } from './approval-timeout.js';
import {
  credentialAccessInCommand,
  credentialAccessInNameFilter,
  credentialAccessInPath,
} from './approvals-credentials.js';
import { isGitDirTarget } from './git-dir-target.js';
import {
  appendToLedger,
  auditLedgerDirFor,
  decisionAudit,
  fullAccessDisabledAudit,
  fullAccessEnabledAudit,
  postureChangedAudit,
} from './policy/audit-ledger.js';
// Approval triggers, policy, and durable decider service.
// The decider is the user — never the model. This module exposes no
// role override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (first-wins latch, the memoOnce
// semantic — the harness primitive itself is not involved). Same-process
// late attach discovers pending asks via pendingRequests(); across a
// restart, pending asks time out to deny by design — only settled
// decisions persist (approvals.json), never open questions. A timeout
// denies the call but stores NOTHING: it is an unanswered
// question, so a later surface can still ask about the same operation —
// only real answers (user, route, autoApprove) enter the latch.
// sessionScoped is enforced by store placement, selected by the host:
// a per-session FileApprovalStore scopes decisions to one session,
// a shared store shares them. The flag documents the intent the host
// must honor when wiring the store.
export const CAPABILITIES = [
  'network',
  'credentials',
  'git-push',
  'destructive-shell',
  'install',
  'deploy',
  'outside-write',
  'privilege-escalation',
  'kubic-state-write',
] as const;

// Kubic's own control plane: a write into
// `<workspace>/.kubic/` could widen the model's future permissions (config,
// roles) or corrupt the state `kubic undo`/`kubic audit` rest on. The model
// never decides its own permissions, so this capability ALWAYS asks — no
// autoApprove entry and no full-access posture answers it.
export const KUBIC_STATE_WRITE = 'kubic-state-write';
const ALWAYS_ASK: ReadonlySet<string> = new Set([KUBIC_STATE_WRITE]);

// The `autoApprove` entries that can never apply because the capability
// always asks. Config keeps accepting them (rejecting would break
// an existing config that never worked); `kubic doctor` and `kubic config`
// name them instead of counting them as auto-approved.
export function alwaysAskAutoApprove(autoApprove: readonly string[]): string[] {
  return autoApprove.filter((capability) => ALWAYS_ASK.has(capability));
}

// Subtrees of `.kubic/` an agent may never write at all (a tool error, not an
// ask): the change journal, the audit ledger and session state.
const REFUSED_STATE_DIRS: ReadonlySet<string> = new Set([
  'journal',
  'audit',
  'sessions',
]);

export type Capability = (typeof CAPABILITIES)[number] | string;

export interface ApprovalPolicy {
  route: 'ask-user' | 'deny';
  autoApprove: Capability[];
  sessionScoped: boolean;
  maxPendingMs: number;
  requireJustification: boolean;
}

class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

// autoApprove is explicit-only: it defaults to empty and must arrive as an
// explicit array. A model cannot infer or inject it because nothing on the
// tool path can supply policy — it comes from config alone.
export function validatePolicy(input: unknown): ApprovalPolicy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyValidationError('approval policy must be an object');
  }
  const record = input as Record<string, unknown>;
  const route = record.route ?? 'ask-user';
  if (route !== 'ask-user' && route !== 'deny') {
    throw new PolicyValidationError(`invalid route: ${JSON.stringify(route)}`);
  }
  const autoApprove = record.autoApprove ?? [];
  if (
    !Array.isArray(autoApprove) ||
    !autoApprove.every((entry) => typeof entry === 'string')
  ) {
    throw new PolicyValidationError(
      'autoApprove must be an explicit string array',
    );
  }
  const maxPendingMs = record.maxPendingMs ?? 60_000;
  if (typeof maxPendingMs !== 'number' || !(maxPendingMs > 0)) {
    throw new PolicyValidationError('maxPendingMs must be a positive number');
  }
  return {
    route,
    autoApprove: [...autoApprove],
    sessionScoped:
      typeof record.sessionScoped === 'boolean' ? record.sessionScoped : true,
    maxPendingMs,
    requireJustification:
      typeof record.requireJustification === 'boolean'
        ? record.requireJustification
        : false,
  };
}

export interface ApprovalRequest {
  key: string;
  capability: Capability;
  toolName: string;
  summary: string;
  // The FULL command a bash call will run — derived from the
  // same args the key hashes, redacted and with hidden characters made
  // visible (approval-display.ts), never truncated. Absent for calls that
  // carry no command (file tools): their summary names the path.
  command?: string;
  justification?: string;
  // An edit or write ask's change against the file on disk (the
  // TUI card's diff preview). Absent when it could not be computed.
  preview?: ToolDisplay;
  // The answers this ask can take beyond allow and deny — the
  // command can be edited before it runs (a shell call), or the edits
  // of the rest of the turn approved at once (an edit/write a role's
  // obligation raised inside the workspace).
  editable?: boolean;
  batchable?: boolean;
}

// The `by` a seat answers for a single-call approval (the TUI overlay's 'a'):
// approved, audited, never latched or persisted.
const ALLOW_ONCE = 'allow-once';
// The `by` for "allow all edits this turn" — this call, and the
// edit/write asks of the same kind until the turn ends; never latched.
export const ALLOW_TURN_EDITS = 'allow-turn-edits';
// The comments and edited commands a seat may send, at most.
const APPROVAL_NOTE_MAX_CHARS = 500;
// The request fields an ask shows: the one-line summary and,
// for a bash call, the full command — both from the call's own args.
function approvalRequestDisplay(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): { summary: string; command?: string } {
  const summary = summarizeRequest(toolName, capability, args);
  return toolName === 'bash' && typeof args.command === 'string'
    ? { summary, command: approvalCommandText(args.command) }
    : { summary };
}

export type ApprovalVerdict =
  | {
      approved: true;
      by: string;
      justified?: boolean;
      // The operator rewrote the command before allowing it; the
      // rewritten call is judged again from the start.
      edited?: { command: string };
    }
  | { approved: false; reason: string };

export interface ApprovalStore {
  load(): Record<string, ApprovalVerdict>;
  save(decisions: Record<string, ApprovalVerdict>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  private decisions: Record<string, ApprovalVerdict> = {};
  load(): Record<string, ApprovalVerdict> {
    return { ...this.decisions };
  }
  save(decisions: Record<string, ApprovalVerdict>): void {
    this.decisions = { ...decisions };
  }
}

// Trigger detection. Predicates are injected so this module stays
// free of shell parsing: the agent owns the classifiers and
// the host owns the decision. The bash detectors are a literal-pattern
// heuristic, not a sandbox: redirect/tee/cp-mv-install
// outside-writes, `sudo` privilege escalation, and destructive/network
// verbs behind command indirection. Indirection coverage, exactly:
// `$(…)` spans (a literal `$(…)`/`)` pairing scan — a bare `(` is ordinary
// text, so closers of other constructs can shift the pairing; the
// scan tracks at most MAX_UNWRAP_DEPTH real openers and its unmatched
// markers still consume closers, so the effective nesting threshold is
// 2x the cap — 31 levels raise, 32 do not), backtick spans, and `eval` segments are unwrapped to
// a fixpoint, so `eval $(rm -rf /)` and `echo $(echo $(rm -rf /))` raise
// too, not only the single-level `$(rm -rf /)`. What still bypasses them —
// stated, not silent: interpreter-based verbs handed over as data
// (`bash -c`, `python3 -c`, `node -e`), substitutions nested past
// ~2x MAX_UNWRAP_DEPTH, python/node/npm exfiltration under network:none,
// quoted or backslash-obfuscated verbs the literal patterns cannot see,
// whitespace tricks around redirection targets, and flag-reordered copy
// targets (`cp -t /etc a b`) the last-argument heuristic misses. Detector
// ownership for the rest:
//   credentials overreach — the credential-path detector
//   (approvals-credentials.ts): well-known home credential locations in a
//     bash command, and the read-family tool paths onto in-workspace
//     credential files (.env*, *.pem, *.key, id_rsa*/id_ed25519*). Gated on
//     the effective `credentials` class, which enforces as `none`
//     (`allowlist` carries no list), so a credential path asks.
//   network under full — fires nothing by design (no network tool exists to
//   remove). A domain-less `allowlist` is enforced as
//     `none`: it fires like `none`, never silently
//     unrestricted.
//   sensitive reads — the filesystem read class governs reads inside the
//     workspace; credential-shaped reads are the one carve-out, raised as
//     the `credentials` capability above, not as a filesystem
//     event.
function networkGated(level: TriggerContext['network']): boolean {
  return effectiveNetworkLevel(level) === 'none';
}

// The credentials class gates its detector exactly like network: enforces
// `allowlist` as `none`, and a hand-built context that names no level reads as
// the safe default. Both keep the detector on — a credential path asks, never a
// silent grant.
function credentialGated(level: TriggerContext['credentials']): boolean {
  return effectiveCredentialLevel(level ?? 'none') === 'none';
}

export interface TriggerContext {
  workspace: string;
  network: 'none' | 'allowlist' | 'full';
  // The installed credentials class. Absent reads as `none`,
  // the safe default, so a hand-built context still challenges credential
  // paths instead of silently allowing them.
  credentials?: CredentialLevel;
  isDestructive: (command: string, workspace: string) => boolean;
  isNetworkCommand: (command: string) => boolean;
  isOutsideWorkspace: (path: string) => boolean;
  // The user's home directory: any write target under `<home>/.kubic`
  // (session state, posture.json, approvals.json) is outside-write
  // whatever the workspace is — even a workspace AT home.
  home?: string;
  requires?: string[];
  /** Kubic state roots beyond the workspace; see ControlPlaneRoots. */
  controlPlane?: ControlPlaneRoots;
}

// git push / remote mutation in ANY command segment: the
// verb is matched after a command-position boundary (start, `|;&`,
// newline, whitespace, a subshell paren — `$(git push)` included — `/`
// (`/usr/bin/git push`), a quote (`bash -c 'git push'`), a
// backslash (`\git push`), a backtick or a `!` — `-c alias.p='!git push'`) and
// after any run of git global
// options (`-C <dir>`, `-c <k=v>`, `--git-dir=…`, `--work-tree …`,
// `--no-pager`, …, an argument may be quoted: `git -C "my dir" push`) — so
// `ls; git push`, `cd x && git push` and `git -C . push` all raise. The word
// must be exactly `git` followed by whitespace: `mygit push`, `digit push`
// and `git-lfs push` never raise. A push named inside a quoted argument
// (`echo "git push later"`) raises too: the literal scan cannot see
// quotes, and an over-trigger is an ask, never a silent grant.
//
// The option run is walked token by token, never by one regex: the old
// repeated alternation (`--namespace` as an option OR as the previous
// option's argument) backtracked exponentially — 34 repeats stalled a real
// `kubic run` for 14 s, and this scan runs before EVERY bash call. Walking is
// a two-state automaton (expecting an option-or-verb / expecting an option
// argument) and the states already explored at a token are remembered across
// every `git` occurrence, so the whole scan is linear in the command.
//
// Words are read TWICE, and either reading reaching `push` raises: quote-aware
// (a quoted option argument is one word, a backslash escapes the next
// character outside single quotes) and plain whitespace-split (the reading the
// original regex had). The quote-aware one catches `git -C "my dir" push`; the
// plain one is the safety net for shell syntax the tokenizer misreads —
// `git -c user.name=O\'Brien push # it's fine` reads `'` as an opening quote
// only when the backslash is ignored. The plain walk is exactly the original
// regex's language, so this only ever widens what raises (fail toward asking);
// the over-trigger it keeps is the original's: a quoted option argument that
// merely contains the word (`git -c "a push" status`) still reads as a push.
const GIT_WORD = /(^|[|;&\s(/'"\\`!])git(?=\s)/gi;
const GIT_ARG_OPTION = /^-c$/i;
// Attached short options: `-C<path>` and `-cname=val` are
// complete in one word — unlike bare `-c`/`-C` they consume nothing more.
const GIT_ATTACHED_SHORT = /^-[cC][\s\S]+$/;
const GIT_FLAG = /^(?:-p|--[a-z][a-z-]*)$/i;
const GIT_VALUE_OPTION =
  /^--(?:git-dir|work-tree|namespace|exec-path|config-env)$/i;
const GIT_VALUE_ASSIGNED =
  /^--(?:git-dir|work-tree|namespace|exec-path|config-env)=[\s\S]+$/i;
const GIT_PUSH_VERB = /^push\b/i;
const GIT_REMOTE_VERB = /^remote$/i;
const GIT_REMOTE_ACTION = /^(?:add|set-url|remove|rename)\b/i;
const WHITESPACE_CHAR = /\s/;
const EXPECT_OPTION = 1;
const EXPECT_ARGUMENT = 2;

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

type TokenReader = (command: string, from: number) => ShellToken | undefined;

// The next whitespace-delimited word at or after `from`, quote-aware: a
// balanced `"…"` or `'…'` run belongs to the word even when it holds spaces,
// a backslash outside single quotes escapes the next character (`\'`, `\ `,
// and `\"` inside double quotes), and a quote with no closer is an ordinary
// character. Stateless from a token start, so a position always tokenizes the
// same way whichever `git` reached it.
function nextShellToken(command: string, from: number): ShellToken | undefined {
  let start = from;
  while (start < command.length && WHITESPACE_CHAR.test(command[start] ?? '')) {
    start += 1;
  }
  if (start >= command.length) return undefined;
  let end = start;
  while (end < command.length && !WHITESPACE_CHAR.test(command[end] ?? '')) {
    const char = command[end];
    if (char === '\\') {
      end = Math.min(end + 2, command.length);
    } else if (char === "'") {
      const close = command.indexOf("'", end + 1);
      end = close < 0 ? end + 1 : close + 1;
    } else if (char === '"') {
      end = afterDoubleQuoted(command, end);
    } else {
      end += 1;
    }
  }
  return { text: command.slice(start, end), start, end };
}

// The index after the double-quoted run opening at `open` (a backslash inside
// escapes the next character), or after the lone quote when nothing closes it.
function afterDoubleQuoted(command: string, open: number): number {
  for (let index = open + 1; index < command.length; index += 1) {
    if (command[index] === '\\') index += 1;
    else if (command[index] === '"') return index + 1;
  }
  return open + 1;
}

// The original reading: a word is a run of non-whitespace, quotes and
// backslashes included.
function nextPlainToken(command: string, from: number): ShellToken | undefined {
  let start = from;
  while (start < command.length && WHITESPACE_CHAR.test(command[start] ?? '')) {
    start += 1;
  }
  if (start >= command.length) return undefined;
  let end = start;
  while (end < command.length && !WHITESPACE_CHAR.test(command[end] ?? '')) {
    end += 1;
  }
  return { text: command.slice(start, end), start, end };
}

function gitVerbFollows(
  command: string,
  from: number,
  explored: Map<number, number>,
  read: TokenReader,
): boolean {
  let states = EXPECT_OPTION;
  let position = from;
  for (;;) {
    const token = read(command, position);
    if (token === undefined) return false;
    const seen = explored.get(token.start) ?? 0;
    // Everything reachable from these states here was already walked by an
    // earlier `git` — and it did not accept, or the scan would have stopped.
    states &= ~seen;
    if (states === 0) return false;
    explored.set(token.start, seen | states);
    let next = 0;
    if ((states & EXPECT_OPTION) !== 0) {
      if (GIT_PUSH_VERB.test(token.text)) return true;
      if (GIT_REMOTE_VERB.test(token.text)) {
        const action = read(command, token.end);
        if (action !== undefined && GIT_REMOTE_ACTION.test(action.text)) {
          return true;
        }
      }
      if (GIT_ARG_OPTION.test(token.text)) next |= EXPECT_ARGUMENT;
      // `-C <dir>` — the regex flag was case-insensitive, so `-C` is `-c`.
      if (
        GIT_FLAG.test(token.text) ||
        GIT_VALUE_ASSIGNED.test(token.text) ||
        GIT_ATTACHED_SHORT.test(token.text)
      ) {
        next |= EXPECT_OPTION;
      }
      // A value option may take the next word or stand alone.
      if (GIT_VALUE_OPTION.test(token.text)) next |= EXPECT_ARGUMENT;
    }
    if ((states & EXPECT_ARGUMENT) !== 0) next |= EXPECT_OPTION;
    if (next === 0) return false;
    states = next;
    position = token.end;
  }
}

function gitPushOrRemoteMutation(command: string): boolean {
  const quoted = new Map<number, number>();
  const plain = new Map<number, number>();
  for (const origin of command.matchAll(GIT_WORD)) {
    const from = origin.index + origin[0].length;
    if (
      gitVerbFollows(command, from, quoted, nextShellToken) ||
      gitVerbFollows(command, from, plain, nextPlainToken)
    ) {
      return true;
    }
  }
  return false;
}

// `git config` that MUTATES: `git config core.hooksPath …`
// rewrites `.git/config` with no file-write target, so the write-target
// detectors never fire — only the settle drift check reports it
// afterwards. Reads (`--get`, `--list`, a bare single-name lookup) stay
// quiet; anything that writes — a set with a value, `--add`, `--unset`
// and friends, `--edit`, a scoped write via `--file` — raises. Same
// two-reader walk as the push detector (quote-aware plus plain
// whitespace-split), linear in the command, failing toward asking.
const GIT_CONFIG_VERB = /^config$/i;
// Display modifiers only: `--show-origin`/`--show-scope`
// neither read nor write, so `git config --show-origin <name> <value>`
// counts positionals and raises while `--show-origin --get <name>` and a
// bare `--show-origin <name>` stay quiet.
const GIT_CONFIG_READ =
  /^(--get|--get-all|--get-regexp|--list|-l|--get-urlmatch|--get-color|--get-colorbool)$/i;
const GIT_CONFIG_WRITE =
  /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit)$/i;
const GIT_CONFIG_VALUE_OPTION = /^--file$/i;
const GIT_CONFIG_FLAG = /^(--[a-z][a-z-]*(=[\s\S]*)?|-[a-z])$/i;

function configMutationFollows(
  command: string,
  from: number,
  explored: Set<number>,
  read: TokenReader,
): boolean {
  let position = from;
  let subcommand = false;
  let readOnly = false;
  let positionals = 0;
  for (;;) {
    const token = read(command, position);
    if (token === undefined) break;
    position = token.end;
    const text = token.text;
    if (!subcommand) {
      // Linear-time memo (same scheme as the push detector): every token
      // an earlier `git` evaluated in pre-subcommand mode evaluates the
      // same way again, so revisiting one ends this walk — the earlier
      // walk already determined what follows from here.
      if (explored.has(token.start)) return false;
      explored.add(token.start);
      // Global options before the subcommand: `-c`/`-C` and the value
      // options consume their argument; anything else flag-shaped skips.
      if (GIT_ARG_OPTION.test(text) || GIT_VALUE_OPTION.test(text)) {
        const value = read(command, position);
        if (value === undefined) return false;
        position = value.end;
        continue;
      }
      if (
        GIT_FLAG.test(text) ||
        GIT_VALUE_ASSIGNED.test(text) ||
        GIT_ATTACHED_SHORT.test(text)
      )
        continue;
      if (GIT_CONFIG_VERB.test(text)) {
        subcommand = true;
        continue;
      }
      return false;
    }
    if (GIT_CONFIG_WRITE.test(text)) return true;
    if (GIT_CONFIG_READ.test(text)) {
      readOnly = true;
      continue;
    }
    if (GIT_CONFIG_VALUE_OPTION.test(text)) {
      const value = read(command, position);
      if (value === undefined) break;
      position = value.end;
      continue;
    }
    if (GIT_CONFIG_FLAG.test(text)) continue;
    positionals += 1;
  }
  if (!subcommand) return false;
  if (readOnly) return false;
  // `git config <name>` reads one value; `git config <name> <value>`
  // (scope flags aside) writes it.
  return positionals >= 2;
}

function gitConfigMutation(command: string): boolean {
  const quoted = new Set<number>();
  const plain = new Set<number>();
  for (const origin of command.matchAll(GIT_WORD)) {
    const from = origin.index + origin[0].length;
    if (
      configMutationFollows(command, from, quoted, nextShellToken) ||
      configMutationFollows(command, from, plain, nextPlainToken)
    ) {
      return true;
    }
  }
  return false;
}

// Package installs and fetch-and-run launchers: every one can
// run arbitrary lifecycle or downloaded code. npm/pnpm/yarn/bun installs,
// npm ci/exec/x, npx/bunx/uvx, pnpm/yarn dlx, a bare `yarn` (which
// installs), pip/pipx/uv, gem, composer, brew, apt, cargo and go.
const INSTALL =
  /(^|[|;&\s(])(npm\s+(i|install|add|clean-install|ci|exec|x)|pnpm\s+(i|install|add|dlx)|yarn(\s+(add|install|dlx|global\s+add)|(?=\s*($|[|;&)])))|bun\s+(i|install|add)|npx|bunx|uvx|pip(3)?\s+install|pipx\s+(install|run)|uv\s+(add|pip\s+install|tool\s+install)|gem\s+install|composer\s+(require|install)|brew\s+install|apt(-get)?\s+install|cargo\s+(install|add)|go\s+install)\b/i;
const DEPLOY =
  /(^|[|;&\s])(kubectl\s+(apply|create|delete|rollout)|docker\s+push|terraform\s+apply|gh\s+release\s+create)\b/i;
// Shell redirection into an absolute target is a write by another name —
// `echo x > /etc/cron.d/x` must raise outside-write like the write tool.
// EVERY redirect operator in the command is scanned, within a
// segment and across `;`/`&&`/`||`/`|`/newline segments, so an inside
// redirect first cannot hide `> /etc/cron.d/x` after it. Operators:
// `>`, `>>`, fd-prefixed `2>`/`1>>` (the digit is just text before the
// operator), `&>`, `&>>`, clobber `>|`, and `>&` — whose target is an fd
// duplication (`2>&1`, `>&-`) and skipped when it is a digit run or `-`,
// and a file otherwise (`>& out.txt`). The target is the next token up to
// whitespace or a `|;&<>` operator character.
const REDIRECT = /(&>>?|>\||>>?&?)[ \t]*([^\s|;&<>]*)/g;
const FD_DUPLICATION = /^(\d+|-)$/;
// tee writes its last argument verbatim — the same class as a `>` redirect,
// so `cat x | sudo tee /etc/cron.d/y` must raise outside-write even though
// no redirect fires. Every command segment is scanned (a `|;&` cannot be
// crossed), so `cp a /etc/b && echo done` cannot hide the write just
// because it is not the tail segment. Only the FINAL named target of the
// segment is checked — `tee /etc/x a.txt` writes `/etc/x` and is a
// documented SILENT miss: the heuristic's errors are mostly over-triggers
// (a raise becomes an ask, never a silent grant), but NOT uniformly so —
// the target rules above are the stated exceptions.
const TEE_TARGET = /\btee\b([^|;&]*)/gi;
// cp/mv/install: the FINAL positional argument is the destination — the
// last-argument heuristic (flags and sources come first). It can point at
// the wrong token when flags reorder arguments (`cp -t /etc a b`); that
// limit is stated here and in docs/cli/configuration.md, not silently
// implied to be exact.
const COPY_TARGET = /\b(cp|mv|install)\b([^|;&]*)/gi;
// Privilege escalation is a capability event on its own:
// `sudo systemctl restart …` is dangerous-shaped whatever verb follows.
// Word-boundary, anywhere in the raw command — quoted context included,
// because a literal scan cannot see into quotes — and over-triggering is
// the documented, safe direction: a raised capability becomes an ask,
// never a silent grant.
const SUDO = /\bsudo\b/;
// Command indirection: a destructive/network verb inside
// `$(…)`, backticks, or after `eval` raises the UNDERLYING capability
// instead of staying silent. The matcher layer documents indirection as
// unenforceable for its guards — detection is cheaper than enforcement
// and the ask is the safety net. `$(…)` is collected with a bounded
// literal `$(…)`/`)` pairing scan (nested substitutions included), and every wrapper
// form unwraps to a fixpoint: `eval $(rm -rf /)`, `echo $(echo $(rm -rf
// /))`, and backtick-wrapped `$(rm -rf /)` all raise, not only the
// single-level `$(rm -rf /)` the first cut handled. Stated bound: nesting
// at 2x MAX_UNWRAP_DEPTH stays unraised — the unmatched-opener
// markers the scan pushes past the cap still consume closers, which
// doubles the effective threshold (31 nesting levels raise, 32 stay
// silent; pinned in the detector tests). A depth cap, never a fabricated
// unwrap.
const MAX_UNWRAP_DEPTH = 16;
const EVAL_SEGMENT = /\beval\s+[^\n|;&]*/g;
const BACKTICK_INDIRECT = /`[^`]*`/g;

// A recorded `$(…)` region: the raw text plus the index of the `)` that
// closed it. The closer index is what lets target extraction trim exactly
// the substitution glue off a LIFTED token — and never a plain one.
interface SubstitutionSpan {
  text: string;
  closer: number;
}

// All `$(…)` regions the scan pairs, in one linear pass — inner regions
// included, so `echo $(echo $(rm -rf /))` yields both `$(rm -rf /)` and
// the outer region. The scan is literal, not a shell parser (a bare `(`
// inside is ordinary text). A `$(` that never closes is skipped; openers
// past MAX_UNWRAP_DEPTH are marked unmatched instead of pairing with some
// inner `)`. Those markers still occupy stack slots and consume closers,
// so past the cap pairing shifts (a recorded region can pair an opener
// with a later `)`) and the effective nesting threshold is ~2x
// MAX_UNWRAP_DEPTH — measured: 31 nesting levels still unwrap, 32 stay
// silent, pinned in the detector tests. Every recorded region is a
// `$(`…`)` substring of the command; the scan never invents text and never
// loops.
function substitutionSpans(command: string): SubstitutionSpan[] {
  const spans: SubstitutionSpan[] = [];
  const openers: number[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '$' && command[index + 1] === '(') {
      openers.push(openers.length < MAX_UNWRAP_DEPTH ? index : -1);
      index += 1;
    } else if (command[index] === ')' && openers.length > 0) {
      const start = openers.pop() ?? -1;
      if (start >= 0) {
        spans.push({ text: command.slice(start, index + 1), closer: index });
      }
    }
  }
  return spans;
}

// Every wrapper cue in the raw command: literal `$(…)` spans (nested ones
// included), `eval` segments, and backtick spans.
function indirectCues(command: string, spans: SubstitutionSpan[]): string[] {
  return [
    ...spans.map((span) => span.text),
    ...(command.match(EVAL_SEGMENT) ?? []),
    ...(command.match(BACKTICK_INDIRECT) ?? []),
  ];
}

// The classifiers anchor on command text (`rm` at a command start), so
// every wrapper must come off before they see the payload: `$(rm -rf /)`
// and backtick-wrapped `rm -rf /` classify as `rm -rf /`, and
// `eval "rm -rf /"` likewise. Unwrapping repeats to a fixpoint — each step
// strictly shortens the payload, and MAX_UNWRAP_DEPTH bounds the walk — so
// `eval $(rm -rf /)` and backtick-wrapped `$(rm -rf /)` come off through
// every layer.
function unwrapIndirection(nested: string): string {
  let inner = nested.trim();
  for (let step = 0; step < MAX_UNWRAP_DEPTH; step += 1) {
    const before = inner;
    if (inner.startsWith('$(') && inner.endsWith(')')) {
      inner = inner.slice(2, -1).trim();
    } else if (inner.startsWith('`') && inner.endsWith('`')) {
      inner = inner.slice(1, -1).trim();
    } else if (/^eval\s+/i.test(inner)) {
      inner = inner.replace(/^eval\s+/i, '').trim();
    } else {
      // Quote wrappers only (`eval "rm -rf /"`, `eval "$(rm -rf /)"`).
      // Deliberately quote-only: the full stripQuotes runs AFTER the loop,
      // so a lifted trailing `)` can never be mistaken for a wrapper
      // delimiter mid-unwrap.
      inner = inner.replace(/^['"]+|['"]+$/g, '');
    }
    if (inner === before) break;
  }
  return stripQuotes(inner);
}

// Shell quoting only: strip a run of surrounding quotes. Targets and
// unwrapped payloads arrive raw from the command string, and quotes are
// shell syntax — the path named is what is inside them (`> "/etc/cron.d/x"`
// names `/etc/cron.d/x`, `tee '/etc/x'` names `/etc/x`).
//
// No delimiter trimming happens here. A trailing `)`/`]` on a PLAIN token
// is path text: `tee '/work)'` names the literal sibling path `/work)`, and
// trimming it would silently widen what counts as inside (an outside → inside
// flip turns an ask into a silent grant). The ONLY delimiter trim in this
// module is the span-closer trim in targetToken, scoped to tokens actually
// lifted out of a `$(…)` span.
function stripQuotes(target: string): string {
  return target.replace(/^['"]+/, '').replace(/['"]+$/, '');
}

// The write target of a detector segment: the last whitespace-separated
// token (last-argument heuristic; segmentEnd is the segment's absolute end
// index in the raw command, so token characters tie back to command
// positions). Quotes and backslash escapes always come off, wherever they sit
// in the token (`".."/x`, `.."/x"`, `\../x` all name `../x`; — the
// same shell reading the control-plane targets get). A trailing delimiter
// comes off ONLY when it is the closing `)` of a `$(…)` span the token was
// lifted from — `$(cp a /work)` names `/work`, because that `)` is
// substitution syntax, not path text — and then exactly the recorded
// closer comes off, never a character that merely looks like one. Plain
// tokens are never trimmed: `tee /work]` names `/work]` and still raises.
// The outside check itself stays path-boundary aware (`/work-evil` is not
// `/work`): quote stripping narrows a token to the path it names, and the
// closer trim removes substitution glue only.
function targetToken(
  segment: string,
  segmentEnd: number,
  spanClosers: ReadonlySet<number>,
): string {
  const trimmed = segment.replace(/\s+$/, '');
  const raw = trimmed.split(/\s+/).pop() ?? '';
  const end = segmentEnd - (segment.length - trimmed.length);
  let cut = 0;
  while (cut < raw.length && spanClosers.has(end - 1 - cut)) {
    cut += 1;
  }
  return shellUnquote(raw.slice(0, raw.length - cut));
}

// Kubic state that does not live under `<workspace>/.kubic/`. `home` is where
// the global `~/.kubic` (config.toml, the default session root) lives — default
// os.homedir(); `sessionsRoot` is the session root actually in use when it was
// overridden elsewhere, refused wholesale.
export interface ControlPlaneRoots {
  home?: string;
  sessionsRoot?: string;
}

// A path the shell would expand from the home directory — `~`, `$HOME`,
// `${HOME}` or `${HOME:-…}`, alone or followed by `/…` — as the part below home
// ('' for home itself); undefined for anything else (`~root`, `$HOMEDIR`,
// `$HOME2`, a plain path). One rule for the control-plane class and for `cd`
// tracking, so `$HOME/.kubic` can never be read differently from `~/.kubic`.
const HOME_PREFIXED = /^(?:~|\$HOME|\$\{HOME(?::?-[^}]*)?\})(?:\/([\s\S]*))?$/;
function homeRelative(path: string): string | undefined {
  const match = HOME_PREFIXED.exec(path);
  return match === null ? undefined : (match[1] ?? '');
}

// The shell's CURRENT directory — `~+`, `$PWD`, `${PWD}` — as the relative path
// below it ('' for the directory itself); undefined for anything else. The
// previous directory (`~-`, `$OLDPWD`) is not knowable from the text.
const PWD_PREFIXED = /^(?:~\+|\$PWD|\$\{PWD(?::?-[^}]*)?\})(?:\/([\s\S]*))?$/;
const OLDPWD_PREFIXED = /^(?:~-|\$OLDPWD|\$\{OLDPWD\})(?:\/|$)/;
function pwdRelative(path: string): string | undefined {
  const match = PWD_PREFIXED.exec(path);
  return match === null ? undefined : (match[1] ?? '');
}

// The path of `target` below `root` as case-folded segments, or undefined
// when it is not at or below `root`.
function segmentsBelow(root: string, target: string): string[] | undefined {
  const rel = relative(root.toLowerCase(), target.toLowerCase());
  if (rel === '') return [];
  if (isAbsolute(rel)) return undefined;
  const parts = rel.split(/[\\/]/);
  return parts[0] === '..' ? undefined : parts;
}

// Where a write target lands in Kubic's control plane, lexically: `refuse`
// for the refused state subtrees, `ask` for anything else under a Kubic state
// directory, undefined elsewhere. The state directories are the workspace's
// own `.kubic/`, and — for a target OUTSIDE the workspace — the `.kubic/` of
// every ancestor (a run from a subdirectory has the project's `.kubic/`
// above it) and `~/.kubic` (global config.toml, the session root). An
// overridden session root is refused wholesale. A leading `~/`, `$HOME/` or
// `${HOME}/` is the home directory, as the shell expands it (the
// variable forms are home paths, not plain outside-writes, which full
// access auto-approves). Case-folded, because the default
// macOS/Windows filesystems are case-insensitive (`.KUBIC/Config.toml` IS the
// config file there). Symlinks are not followed — lexical, like every shell
// detector in this module.
function controlPlaneClass(
  workspace: string,
  target: string,
  roots: ControlPlaneRoots = {},
): 'refuse' | 'ask' | undefined {
  const path = stripQuotes(target);
  if (path === '') return undefined;
  const home = roots.home ?? homedir();
  const ws = resolve(workspace);
  const belowHome = homeRelative(path);
  const abs =
    belowHome === undefined ? resolve(ws, path) : resolve(home, belowHome);
  const literal = literalControlPlaneClass(ws, abs, home, roots);
  if (literal === 'refuse') return literal;
  // A glob (or brace list) that COULD expand into state is refused, not just
  // asked: `rm .kubic/journa?/*` names no file the scan can see, but it is the
  // journal. The bash tool's shell would expand it; we cannot, so every
  // expansion the pattern allows counts.
  return GLOB_CHARS.test(abs) && globReachesState(abs, ws, home, roots)
    ? 'refuse'
    : literal;
}

// The Kubic state directories a path can fall under: the workspace's own
// `.kubic`, and — when the path is OUTSIDE the workspace — every ancestor's and
// the home's.
function stateDirsFor(ws: string, home: string, outside: boolean): string[] {
  const dirs = [join(ws, '.kubic')];
  if (!outside) return dirs;
  for (let dir = dirname(ws); ; dir = dirname(dir)) {
    dirs.push(join(dir, '.kubic'));
    if (dirname(dir) === dir) break;
  }
  dirs.push(join(resolve(home), '.kubic'));
  return dirs;
}

function literalControlPlaneClass(
  ws: string,
  abs: string,
  home: string,
  roots: ControlPlaneRoots,
): 'refuse' | 'ask' | undefined {
  if (
    roots.sessionsRoot !== undefined &&
    segmentsBelow(resolve(roots.sessionsRoot), abs) !== undefined
  ) {
    return 'refuse';
  }
  for (const stateDir of stateDirsFor(
    ws,
    home,
    segmentsBelow(ws, abs) === undefined,
  )) {
    const parts = segmentsBelow(stateDir, abs);
    if (parts === undefined) continue;
    const sub = parts[0];
    return sub !== undefined && REFUSED_STATE_DIRS.has(sub) ? 'refuse' : 'ask';
  }
  return undefined;
}

// Glob matching for the control-plane guard. Metacharacters: `*`, `?`, `[…]`
// and `{a,b}`. Deliberately conservative: a leading `*` may match a dotfile
// (`shopt -s dotglob` exists), and an enumeration that overflows is refused
// whenever the path names `.kubic`.
const GLOB_CHARS = /[*?[{]/;
const PROTECTED_SUBS = ['journal', 'audit', 'sessions', 'config.toml', 'roles'];
const BRACE_LIMIT = 32;

function globReachesState(
  abs: string,
  ws: string,
  home: string,
  roots: ControlPlaneRoots,
): boolean {
  const variants = expandBraces(abs);
  if (variants === undefined) return /\.kubic/i.test(abs);
  const dirs = stateDirsFor(ws, home, true).map(pathSegments);
  const sessions =
    roots.sessionsRoot === undefined
      ? undefined
      : pathSegments(resolve(roots.sessionsRoot));
  return variants.some((variant) => {
    const segments = pathSegments(variant);
    return (
      dirs.some((dir) => globReaches(segments, dir, PROTECTED_SUBS)) ||
      (sessions !== undefined && globReaches(segments, sessions, undefined))
    );
  });
}

function pathSegments(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\\/]/)
    .filter((part) => part !== '');
}

// Can the (possibly globbed) path `segments` name `dir` itself or something
// below it that is protected? `subs` lists the protected first-level names;
// undefined protects everything below (the session root).
function globReaches(
  segments: readonly string[],
  dir: readonly string[],
  subs: readonly string[] | undefined,
): boolean {
  // A path shorter than `dir` runs out of segments: '' matches no name.
  for (let index = 0; index < dir.length; index += 1) {
    if (!globMatches(segments[index] ?? '', dir[index] ?? '')) return false;
  }
  if (segments.length === dir.length || subs === undefined) return true;
  const next = segments[dir.length] ?? '';
  return subs.some((sub) => globMatches(next, sub));
}

// fnmatch for one path segment (both sides case-folded): `*`, `?`, `[set]`,
// `[!set]` / `[^set]` and ranges. Iterative with one backtrack point, so it is
// O(pattern x name) whatever the pattern.
function globMatches(pattern: string, name: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === name;
  let p = 0;
  let n = 0;
  let starAt = -1;
  let starName = 0;
  while (n < name.length) {
    if (pattern[p] === '*') {
      starAt = p;
      starName = n;
      p += 1;
      continue;
    }
    const next = p < pattern.length ? matchOne(pattern, p, name[n] ?? '') : -1;
    if (next >= 0) {
      p = next;
      n += 1;
    } else if (starAt >= 0) {
      p = starAt + 1;
      starName += 1;
      n = starName;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

// One pattern element against one character: the pattern index after it, or -1.
function matchOne(pattern: string, at: number, char: string): number {
  const first = pattern[at];
  if (first === '?') return at + 1;
  if (first === '[') {
    const negate = pattern[at + 1] === '!' || pattern[at + 1] === '^';
    const start = at + (negate ? 2 : 1);
    const close = pattern.indexOf(']', start + 1);
    if (close > 0) {
      let inSet = false;
      for (let index = start; index < close; index += 1) {
        const from = pattern[index] ?? '';
        if (pattern[index + 1] === '-' && index + 2 < close) {
          if (char >= from && char <= (pattern[index + 2] ?? '')) inSet = true;
          index += 2;
        } else if (char === from) {
          inSet = true;
        }
      }
      return inSet === !negate ? close + 1 : -1;
    }
  }
  return first === char ? at + 1 : -1;
}

// `a{b,c}d` -> `abd`, `acd` (nested and multiple groups; a group with no comma
// is literal). undefined when the enumeration would pass BRACE_LIMIT or the
// text is too long to scan.
function expandBraces(text: string): string[] | undefined {
  if (text.length > 2048) return undefined;
  const pending = [text];
  const done: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop() ?? '';
    const group = firstBraceGroup(current);
    if (group === undefined) {
      done.push(current);
    } else {
      for (const option of group.options) {
        pending.push(group.before + option + group.after);
      }
    }
    if (done.length + pending.length > BRACE_LIMIT) return undefined;
  }
  return done;
}

function firstBraceGroup(
  text: string,
): { before: string; options: string[]; after: string } | undefined {
  for (
    let open = text.indexOf('{');
    open >= 0;
    open = text.indexOf('{', open + 1)
  ) {
    let depth = 0;
    const commas: number[] = [];
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (char === '{') depth += 1;
      else if (char === ',' && depth === 1) commas.push(index);
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          if (commas.length === 0) break;
          const bounds = [open, ...commas, index];
          return {
            before: text.slice(0, open),
            options: bounds
              .slice(0, -1)
              .map((from, at) => text.slice(from + 1, bounds[at + 1])),
            after: text.slice(index + 1),
          };
        }
      }
    }
  }
  return undefined;
}

// Every path a call writes or destroys: write/edit's `path`, and for bash every
// redirect (`>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `N>`), tee and cp/mv/install
// target — the same lexical shapes the outside-write detector reads — plus the
// operands of `rm` and `mv` (deleting or moving `.kubic/journal` is tampering
// exactly like writing it; a `cp` SOURCE is only read, so it is not one).
// Redirects are scanned one by one, so a trailing `2>/dev/null` cannot mask an
// earlier target. A bash token is read the way the shell would: inner quotes
// and backslash escapes come off (`".kubic"/roles/r.md`).
//
// Each bash target yields TWO candidates and either one being control-plane is
// enough: the token as typed against the workspace, and the token resolved
// against the directory the preceding `cd`/`pushd` trail leaves (the cdEvents
// machinery the outside-write detector uses). The trail is lexical — it cannot
// tell a subshell, a conditional or a quoted `cd` from a real one — so it must
// only ever ADD a candidate; replacing the typed path with it let `(cd x);
// echo p > .kubic/journal/y` through. After a `cd` to an unknown place a
// relative token naming a `.kubic` segment is read as the workspace's own —
// fail-closed (an agent has no business in any `.kubic/journal`, so even the
// refusal class costs nothing).
const WRITE_TARGETS_MEMO = new Map<string, string[]>();
function writeTargets(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  home: string,
): string[] {
  if (toolName === 'write' || toolName === 'edit') {
    return typeof args.path === 'string' ? [args.path] : [];
  }
  if (toolName !== 'bash' || typeof args.command !== 'string') return [];
  const command = args.command;
  return memoised(WRITE_TARGETS_MEMO, `${workspace}\0${home}\0${command}`, () =>
    bashWriteTargets(command, workspace, home),
  );
}

function bashWriteTargets(
  command: string,
  workspace: string,
  home: string,
): string[] {
  const found: Array<{ raw: string; index: number }> = [];
  for (const match of command.matchAll(ALL_REDIRECT_TARGETS)) {
    const raw = match[2] ?? '';
    if (match[1] === '&' && FD_DUPLICATION.test(raw)) continue;
    found.push({ raw, index: match.index });
  }
  for (const tee of command.matchAll(TEE_TARGET)) {
    found.push({
      raw: (tee[1] ?? '').trim().split(/\s+/).pop() ?? '',
      index: tee.index,
    });
  }
  for (const copy of command.matchAll(COPY_TARGET)) {
    found.push({
      raw: (copy[2] ?? '').trim().split(/\s+/).pop() ?? '',
      index: copy.index,
    });
  }
  for (const removal of command.matchAll(REMOVE_MOVE_OPERANDS)) {
    for (const operand of (removal[2] ?? '').trim().split(/\s+/)) {
      if (operand !== '' && !operand.startsWith('-')) {
        found.push({ raw: operand, index: removal.index });
      }
    }
  }
  const trail = cdEvents(command, workspace, home);
  const ws = resolve(workspace);
  const targets = new Set<string>();
  for (const { raw, index } of found) {
    const token = shellUnquote(raw.replace(/[)`]+$/, ''));
    targets.add(pathAtCwd(token, ws, workspace));
    targets.add(pathAtCwd(token, cwdAt(trail, index, workspace), workspace));
  }
  return [...targets];
}

// A relative bash token joined onto the directory it is written from; shell
// expansions and absolute paths are left for controlPlaneClass. `~+`/`$PWD`
// are the directory itself. The cwd IS the workspace hands the token over
// exactly as typed. An unknown directory (`cd $X`, `~-`, `$OLDPWD`) reads a
// `.kubic` segment as the workspace's own.
function pathAtCwd(
  token: string,
  cwd: string | null,
  workspace: string,
): string {
  if (token === '' || homeRelative(token) !== undefined || isAbsolute(token)) {
    return token;
  }
  const ws = resolve(workspace);
  if (OLDPWD_PREFIXED.test(token)) return failClosedKubic(token, ws);
  const here = pwdRelative(token);
  const local = here ?? token;
  if (cwd === ws) return local;
  if (cwd !== null) return resolve(cwd, local);
  return failClosedKubic(local, ws);
}

function failClosedKubic(token: string, ws: string): string {
  const segments = token.split('/');
  const at = segments.findIndex(
    (segment) => segment.toLowerCase() === '.kubic',
  );
  return at < 0 ? token : join(ws, ...segments.slice(at));
}

// A tiny bounded memo for per-command scans: the same bash command is read by
// the control-plane refusal and by trigger detection, and an 8000-target
// command made each of them re-scan every earlier `cd`.
const MEMO_LIMIT = 8;
function memoised<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (cache.size >= MEMO_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

// Every redirect target in a command (see writeTargets), with the operator's
// `&` when it has one: `>&` names a file unless the target is an fd
// duplication (`2>&1`, `>&-` — skipped by the caller), `&>`/`&>>` are plain
// redirects. Process substitutions are not file targets and are skipped.
const ALL_REDIRECT_TARGETS = />{1,2}([|&])?\s*([^\s|;&<>()]+)/g;
// rm/mv operands: the whole argument run of the segment (flags are dropped by
// the caller). Sources are included because removing or moving state is a
// write to it.
const REMOVE_MOVE_OPERANDS = /\b(rm|mv)\b([^|;&]*)/gi;

// A bash token as the shell reads it: quotes come off wherever they sit
// (`".kubic"/roles`, `.k"ub"ic`) and a backslash escapes the next character
// (`\.kubic`). Over-approximate on purpose — a quote is never part of a path
// worth telling apart from the state dir, and a wrong read only asks.
function shellUnquote(token: string): string {
  return token.replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

// The named refusal for a write into refused control-plane state, or undefined.
// The caller returns it as a tool error without asking.
export function controlPlaneRefusal(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  roots: ControlPlaneRoots = {},
): string | undefined {
  const home = roots.home ?? homedir();
  for (const target of writeTargets(toolName, args, workspace, home)) {
    if (controlPlaneClass(workspace, target, roots) === 'refuse') {
      return `refused: ${stripQuotes(target)} is Kubic control-plane state (.kubic/journal, .kubic/audit, .kubic/sessions) — agents may not write it`;
    }
  }
  return undefined;
}

// Shell-expanded and cd-relative write targets. The literal
// detectors see the command before bash expands it, so a target starting
// with `~` (`~/.bashrc`, `~root/x`) or `$` (`$HOME/.zshrc`, `${HOME}/x`,
// any `$VAR/...`) names a path the workspace check cannot know — it counts
// as OUTSIDE, fail-closed, never joined under the workspace. A preceding
// `cd <dir>` / `pushd <dir>` at a command start moves the cwd relative
// targets resolve against for the rest of the command: into an outside dir
// they resolve outside, and to an unknown one (bare `cd`, `cd ~`, `cd $X`,
// `cd -`, any `popd`) every later relative target fails closed.
//
// The trail is lexical, so it is only ever ONE of two candidates: a target is
// outside if it is outside as typed against the workspace OR as resolved
// against the tracked cwd. A subshell `(cd /etc)`, a conditional `false && cd
// /etc` or a `cd` quoted into an argument therefore over-triggers and can
// never hide a write (the tracked cwd alone let `(cd sub); echo x > ../y`
// through).
//
// A `cd` is only a cd at a COMMAND START: after `^`, `;`, `&`, `|`, a newline or
// `(`, then any run of the reserved words that run the next command in the
// current shell — `if`/`elif`/`then`/`do`/`else`/`while`/`until`, `{`, `!` — and
// the `command`/`builtin` wrappers. Each needs trailing whitespace, and a
// keyword in the middle of an argument (`git commit -m 'then cd /x'`) starts
// nothing. Not modelled, stated: `time cd`, `eval cd`, `bash -c 'cd …'`, and a
// subshell `cd` that undoes an earlier one. The command's own text runs to
// the next `;`, `|`, newline or `)` — and to a `&` only when it belongs to a
// redirection (`2>&1`, `>&`, `&>`), so `cd 2>&1 .kubic` keeps its directory.
const CD_COMMAND =
  /(^|[;&|\n(])[ \t]*(?:(?:if|elif|then|do|else|while|until|\{|!|command|builtin)[ \t]+)*(cd|pushd|popd)(?=$|[\s;&|)])((?:[^;&|\n)]|&(?=>)|(?<=[<>])&)*)/g;
const SHELL_EXPANDED = /^[~$]/;
// Stream pseudo-devices persist nothing: `2>/dev/null` or `> /dev/stderr`
// anywhere in a command is not an outside write (exact paths only — any
// other /dev target is a real device and still raises).
const STREAM_DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// `end` is where the cd command's own text stops: a redirect inside it
// (`cd .. > config.toml`) is applied BEFORE the cd runs.
interface CdEvent {
  index: number;
  end: number;
  cwd: string | null;
}

// A redirection word: `>`, `>>`, `2>`, `&>`, `>&`, `>|`, `<`, `<<`, `<&`, `N>&M`…
// When the operator stands alone the NEXT word is its target.
const REDIRECT_WORD = /^(?:&>>?|\d*(?:>>|>&|>\||>|<&|<>|<<<|<<|<))/;

// The directory a `cd` names: the first word that is neither a redirection
// (`cd 2>/dev/null .kubic`) nor an option (`-L`, `-P`, `-e`, `-@`, `--`),
// quote-aware, read the way the shell would.
function cdArgument(rest: string): string {
  let at = 0;
  for (;;) {
    const token = nextShellToken(rest, at);
    if (token === undefined) return '';
    at = token.end;
    const redirect = REDIRECT_WORD.exec(token.text);
    if (redirect !== null) {
      if (redirect[0].length === token.text.length) {
        at = nextShellToken(rest, at)?.end ?? at;
      }
      continue;
    }
    if (token.text === '--' || /^-[LPe@]+$/.test(token.text)) continue;
    return shellUnquote(token.text);
  }
}

const CD_EVENTS_MEMO = new Map<string, CdEvent[]>();
const MAX_TRACKED_CWD = 1024;

// `home` is optional: given (the control-plane detector), `cd ~` and
// `cd $HOME/x` resolve against it; absent (the outside-write detector),
// they stay an unknown place and every later relative target fails closed, as
// documented. `cd "$PWD/x"` and `cd ~+/x` are relative to the tracked cwd.
function cdEvents(
  command: string,
  workspace: string,
  home?: string,
): CdEvent[] {
  return memoised(
    CD_EVENTS_MEMO,
    `${workspace}\0${home ?? '\u0001'}\0${command}`,
    () => computeCdEvents(command, workspace, home),
  );
}

function computeCdEvents(
  command: string,
  workspace: string,
  home?: string,
): CdEvent[] {
  const events: CdEvent[] = [];
  let cwd: string | null = resolve(workspace);
  for (const match of command.matchAll(CD_COMMAND)) {
    const dir = match[2] === 'popd' ? '' : cdArgument(match[3] ?? '');
    const belowHome = home === undefined ? undefined : homeRelative(dir);
    const belowPwd = pwdRelative(dir);
    if (home !== undefined && belowHome !== undefined) {
      cwd = resolve(home, belowHome);
    } else if (belowPwd !== undefined) {
      cwd = cwd === null ? null : resolve(cwd, belowPwd);
    } else if (
      dir === '' ||
      dir.startsWith('-') ||
      /[~$`]/.test(dir[0] ?? '')
    ) {
      cwd = null;
    } else if (isAbsolute(dir)) {
      cwd = resolve(dir);
    } else if (cwd !== null) {
      cwd = resolve(cwd, dir);
    }
    // A tracked directory past 1 KiB is not a real one (`cd a` repeated 8000
    // times built a 16 KiB path that every later target re-resolved): treated
    // as unknown, which fails closed.
    if (cwd !== null && cwd.length > MAX_TRACKED_CWD) cwd = null;
    events.push({
      index: match.index + (match[1] ?? '').length,
      end: match.index + match[0].length,
      cwd,
    });
  }
  return events;
}

// The tracked cwd at `position`: the last cd that starts before it — unless
// the position is inside that cd's own text, where it has not run yet.
function cwdAt(
  events: readonly CdEvent[],
  position: number,
  workspace: string,
): string | null {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((events[mid]?.index ?? 0) < position) low = mid + 1;
    else high = mid;
  }
  let last = low - 1;
  if (last >= 0 && position < (events[last]?.end ?? 0)) last -= 1;
  return last < 0 ? resolve(workspace) : (events[last]?.cwd ?? null);
}

function underKubicHome(path: string, home: string | undefined): boolean {
  if (home === undefined) return false;
  const state = resolve(home, '.kubic');
  return path === state || path.startsWith(`${state}/`);
}

function shellTargetOutside(
  target: string,
  cwd: string | null,
  ctx: TriggerContext,
): boolean {
  if (SHELL_EXPANDED.test(target)) return true;
  if (isAbsolute(target)) {
    if (STREAM_DEVICE.test(resolve(target))) return false;
    return (
      underKubicHome(resolve(target), ctx.home) ||
      ctx.isOutsideWorkspace(target)
    );
  }
  if (cwd === null) return true;
  const absolute = resolve(cwd, target);
  if (underKubicHome(absolute, ctx.home)) return true;
  // No cd moved the cwd: hand the raw token over, exactly as before.
  return ctx.isOutsideWorkspace(
    cwd === resolve(ctx.workspace) ? target : absolute,
  );
}

// The read-family arguments that name what a call opens (the same path/root
// mapping the agent confines with, CONFINED_TOOLS in interceptors.ts) plus
// the name FILTERS: `grep.include` and `find.nameContains` select files by
// substring, so `include: '.env'` reaches a committed `.env` without naming
// a path at all. The ask runs before that rewrite, so an
// as-typed home path is still seen here.
const READ_PATH_ARGS: Record<string, readonly string[]> = {
  read: ['path'],
  ls: ['path'],
  grep: ['root', 'include'],
  find: ['root', 'nameContains'],
};
const READ_FILTER_ARGS: ReadonlySet<string> = new Set([
  'include',
  'nameContains',
]);

export function detectTriggers(
  toolName: string,
  args: Record<string, unknown>,
  ctx: TriggerContext,
): Capability[] {
  const found: Capability[] = [];
  if (ctx.requires?.includes(toolName) === true) {
    found.push(`requires:${toolName}`);
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = args.command;
    // One span scan per command: the target detectors trim a lifted token's
    // substitution closer by span-closer index, and the indirection cues
    // below reuse the same spans.
    const spans = substitutionSpans(command);
    const spanClosers = new Set(spans.map((span) => span.closer));
    if (ctx.isDestructive(command, ctx.workspace))
      found.push('destructive-shell');
    if (networkGated(ctx.network) && ctx.isNetworkCommand(command))
      found.push('network');
    if (gitPushOrRemoteMutation(command)) found.push('git-push');
    // `git config` sets rewrite `.git/config` with no
    // file-write target, so the write-target detectors never fire.
    if (gitConfigMutation(command)) found.push(KUBIC_STATE_WRITE);
    if (INSTALL.test(command)) found.push('install');
    if (DEPLOY.test(command)) found.push('deploy');
    // Every write target (redirect, tee, cp/mv/install) goes through one
    // check: resolved against the cwd a preceding `cd`/`pushd` left behind,
    // failing closed on shell-expanded prefixes.
    const cdTrail = cdEvents(command, ctx.workspace);
    const typedCwd = resolve(ctx.workspace);
    const outside = (raw: string, end: number, start: number): boolean => {
      // Targets arrive raw: quotes always come off, and a lifted token also
      // loses its substitution closer (targetToken) — so `> "/etc/cron.d/x"`
      // and `echo $(cp a /etc/b)` cannot dodge the outside check while a
      // plain literal `)`/`]` stays part of the path. Outside if EITHER the
      // token as typed OR its cd-tracked resolution is (see the cd notes above).
      const target = targetToken(raw, end, spanClosers);
      if (target === '') return false;
      if (shellTargetOutside(target, typedCwd, ctx)) return true;
      const tracked = cwdAt(cdTrail, start, ctx.workspace);
      return tracked !== typedCwd && shellTargetOutside(target, tracked, ctx);
    };
    const targets: Array<[string, number, number]> = [];
    for (const redirect of command.matchAll(REDIRECT)) {
      const raw = redirect[2] ?? '';
      if (redirect[1]?.endsWith('&') === true && FD_DUPLICATION.test(raw)) {
        continue;
      }
      targets.push([raw, redirect.index + redirect[0].length, redirect.index]);
    }
    // Shell-side writes by another name: tee and trailing
    // cp/mv/install targets reach files no `>` ever touches. Both use the
    // same shared quote-stripping and last-argument target extraction,
    // scoped so the closer trim fires only on lifted tokens.
    for (const tee of command.matchAll(TEE_TARGET)) {
      targets.push([tee[1] ?? '', tee.index + tee[0].length, tee.index]);
    }
    for (const copy of command.matchAll(COPY_TARGET)) {
      targets.push([copy[2] ?? '', copy.index + copy[0].length, copy.index]);
    }
    if (targets.some(([raw, end, start]) => outside(raw, end, start))) {
      found.push('outside-write');
    }
    // Privilege escalation and command indirection: sudo is a
    // capability event wherever it sits, and a destructive/network verb
    // behind $(…) (nested spans included), backticks, or eval raises the
    // UNDERLYING capability — never a new one — instead of hiding behind
    // the matcher layer's stated indirection gap.
    if (SUDO.test(command)) {
      found.push('privilege-escalation');
    }
    for (const nested of indirectCues(command, spans)) {
      const payload = unwrapIndirection(nested);
      if (payload === '') continue;
      if (ctx.isDestructive(payload, ctx.workspace)) {
        found.push('destructive-shell');
      }
      if (networkGated(ctx.network) && ctx.isNetworkCommand(payload)) {
        found.push('network');
      }
    }
    if (
      credentialGated(ctx.credentials) &&
      credentialAccessInCommand(command) !== undefined
    ) {
      found.push('credentials');
    }
  }
  // In-workspace credential files: confinement already keeps
  // the tools inside the workspace, but `.env*` and key material committed
  // there are exactly the files the class is about.
  const readArgs = READ_PATH_ARGS[toolName];
  if (readArgs !== undefined && credentialGated(ctx.credentials)) {
    for (const arg of readArgs) {
      const value = args[arg];
      if (typeof value !== 'string') continue;
      const hit = READ_FILTER_ARGS.has(arg)
        ? (credentialAccessInPath(value) ?? credentialAccessInNameFilter(value))
        : credentialAccessInPath(value);
      if (hit !== undefined) {
        found.push('credentials');
        break;
      }
    }
  }
  if (
    (toolName === 'write' || toolName === 'edit') &&
    typeof args.path === 'string'
  ) {
    if (
      underKubicHome(resolve(ctx.workspace, args.path), ctx.home) ||
      ctx.isOutsideWorkspace(args.path)
    ) {
      found.push('outside-write');
    }
  }
  // A write under the workspace's own `.git/` (hooks, config)
  // is control-plane-grade tampering — a planted hook runs on the host's
  // later git commands — so it raises the same always-ask capability.
  if (
    writeTargets(
      toolName,
      args,
      ctx.workspace,
      ctx.controlPlane?.home ?? homedir(),
    ).some(
      (target) =>
        controlPlaneClass(ctx.workspace, target, ctx.controlPlane) !==
          undefined || isGitDirTarget(ctx.workspace, target),
    )
  ) {
    found.push(KUBIC_STATE_WRITE);
  }
  return [...new Set(found)];
}

// Stable across restarts: the same dangerous op re-proposed after a crash
// maps to the same key, so a stored decision applies and the user is not
// re-asked. Tool-call ids are deliberately excluded — they change per run.
export function approvalKey(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(sortKeys(args));
  return createHash('sha256')
    .update(`${toolName}|${capability}|${canonical}`)
    .digest('hex')
    .slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function summarizeRequest(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  // Summaries reach the TUI and the trajectory: secret-shaped values are
  // redacted exactly like block reasons.
  if (toolName === 'bash' && typeof args.command === 'string') {
    // Never a silent slice — a shortened summary says how much
    // it hid; the full command travels in the request's `command` field.
    return summarizeCommand(capability, args.command);
  }
  if (typeof args.path === 'string') {
    return redactReason(`${capability}: ${toolName} ${args.path}`);
  }
  return `${capability}: ${toolName}`;
}

// File-backed store: decisions + full-access posture live beside the
// session that scoped them, so a fresh session starts safe (no file →
// default deny posture). posture.json sits beside the session for the
// audit/doctor readers coming. Load is corrupt-tolerant;
// saves are atomic tmp+rename (races fail safe to deny on load).
export interface AccessPosture {
  fullAccess: boolean;
  enabledAt?: number;
  enabledBy?: string;
}

// Shape validation for the on-disk state. Load is
// corrupt-tolerant by contract — a file that PARSES but is the wrong shape
// (`null`, `[]`, `"x"`, `3`) must fall back to the documented safe default,
// never be cast and then crash the boot (`Object.entries(null)` in the
// service constructor, `.fullAccess` on null in installedPolicyPosture).
// Malformed INDIVIDUAL entries are dropped, not the whole file: one bad key
// must not erase every decision beside it. Each reader rebuilds the object
// field by field, so unknown keys never ride along.
function verdictFrom(value: unknown): ApprovalVerdict | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.approved === true) {
    if (typeof record.by !== 'string') return undefined;
    return {
      approved: true,
      by: record.by,
      // A malformed optional field is dropped, never fabricated: without
      // `justified: true` the service's requireJustification staleness rule
      // re-asks, which is the fail-safe direction.
      ...(typeof record.justified === 'boolean'
        ? { justified: record.justified }
        : {}),
    };
  }
  if (record.approved === false) {
    if (typeof record.reason !== 'string') return undefined;
    return { approved: false, reason: record.reason };
  }
  return undefined;
}

function decisionsFrom(value: unknown): Record<string, ApprovalVerdict> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, ApprovalVerdict> = {};
  for (const [key, entry] of Object.entries(value)) {
    const verdict = verdictFrom(entry);
    if (verdict !== undefined) out[key] = verdict;
  }
  return out;
}

function postureFrom(value: unknown): AccessPosture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { fullAccess: false };
  }
  const record = value as Record<string, unknown>;
  // `true` exactly: `"yes"`, `1` and a missing field are all not a grant.
  if (record.fullAccess !== true) return { fullAccess: false };
  return {
    fullAccess: true,
    ...(typeof record.enabledAt === 'number' &&
    Number.isFinite(record.enabledAt)
      ? { enabledAt: record.enabledAt }
      : {}),
    ...(typeof record.enabledBy === 'string'
      ? { enabledBy: record.enabledBy }
      : {}),
  };
}

export class FileApprovalStore implements ApprovalStore {
  private readonly file: string;
  private readonly postureFile: string;

  constructor(dir: string) {
    this.file = join(dir, 'approvals.json');
    this.postureFile = join(dir, 'posture.json');
  }

  load(): Record<string, ApprovalVerdict> {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.file)) return {};
    try {
      return decisionsFrom(JSON.parse(bridge.readTextFile(this.file)));
    } catch {
      return {};
    }
  }

  save(decisions: Record<string, ApprovalVerdict>): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Approval state is private like the rest of the session dir.
    bridge.writeFile(tmp, JSON.stringify(decisions), { mode: 0o600 });
    try {
      bridge.renameFile(tmp, this.file);
    } catch (error) {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw error;
    }
  }

  loadPosture(): AccessPosture {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.postureFile)) return { fullAccess: false };
    try {
      return postureFrom(JSON.parse(bridge.readTextFile(this.postureFile)));
    } catch {
      return { fullAccess: false };
    }
  }

  savePosture(posture: AccessPosture): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.postureFile}.${process.pid}.tmp`;
    // Posture state is private like the rest of the session dir.
    bridge.writeFile(tmp, JSON.stringify(posture), { mode: 0o600 });
    try {
      bridge.renameFile(tmp, this.postureFile);
    } catch (error) {
      // The same cleanup save() has: a failed rename must not
      // strand `posture.json.<pid>.tmp` beside the session.
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw error;
    }
  }
}

// Adapter from the service to the agent's approve hook. Non-triggered calls
// pass immediately WITHOUT challenging — the agent keeps every guard up for
// them. Triggered calls need every raised capability approved and return
// challenged=true so the agent stands down the guards for exactly that call.
// Full-access approves everything as challenged AND records the posture —
// indicated, recorded beside the session for audit/doctor readers — never
// quiet. The ask is awaited inside the pi-durable ToolTask beforeTool hook: the
// service's own maxPendingMs bound still denies on timeout, and the hook runs
// before the tool's intent commit, so a crash while a seat is deciding re-asks
// on resume rather than resuming an unapproved call. Single-sourced with the
// agent seam: `ApprovalCall`/`ApprovalAskVerdict` are the agent's types, so
// ask and hook cannot drift apart.
type ApprovalAsk = (call: ApprovalCall) => Promise<ApprovalAskVerdict>;

export function enableFullAccess(
  store: FileApprovalStore,
  by: string,
  clock: () => number = Date.now,
): AccessPosture {
  const posture: AccessPosture = {
    fullAccess: true,
    enabledAt: clock(),
    enabledBy: by,
  };
  store.savePosture(posture);
  return posture;
}

// The symmetric half — a session switched back to
// enforced approvals. Writes the same posture.json the enable path writes
// (so a resume boots enforced) and returns the posture it recorded.
function disableFullAccess(
  store: FileApprovalStore,
  by: string,
  clock: () => number = Date.now,
): AccessPosture {
  const posture: AccessPosture = {
    fullAccess: false,
    enabledAt: clock(),
    enabledBy: by,
  };
  store.savePosture(posture);
  return posture;
}

// The one flag name for session-scoped full access.
export const FULL_ACCESS_FLAG = '--dangerously-skip-approvals';

export interface SessionFullAccessOptions {
  /**
   * The session dir whose posture.json records the grant. Absent: only the
   * audit row and the warning are produced.
   */
  sessionDir?: string;
  sessionId: string;
  /** The command after `kubic`: 'run', 'tui', 'sessions create'. */
  command: string;
  /** Resolves the repo ledger (resolveRepoRuntimeRoot). */
  workspace: string;
  clock?: () => number;
  onAuditError?: (message: string) => void;
}

export interface SessionFullAccessGrant {
  posture: AccessPosture;
  /** The stderr warning every enabling command prints, word for word. */
  warning: string;
}

interface FullAccessChange {
  enabled: boolean;
  /** The command recorded in the posture file and the audit row. */
  by: string;
  sessionId: string;
  workspace: string;
  /** The posture store to write; absent falls back to `sessionDir`. */
  store?: FileApprovalStore;
  sessionDir?: string;
  clock?: () => number;
  onAuditError?: (message: string) => void;
}

// The ONE writer for a session-scoped full-access change: the posture file and
// its audit row are produced here, so the CLI-shaped session helpers and the
// installed policy's in-session toggle cannot drift into two writers for one
// row shape. Exactly one clock read produces the record the file holds, and it
// is RETURNED, so a caller that keeps an in-memory posture (the guard's
// baseline) re-bases on the file's own values instead of a second `Date.now()`
// that could tick in between — a difference the guard would read as a foreign
// change and answer with a false `posture:changed-mid-session` row.
function recordFullAccessChange(change: FullAccessChange): AccessPosture {
  const clock = change.clock ?? Date.now;
  const store =
    change.store ??
    (change.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(change.sessionDir));
  const posture: AccessPosture =
    store === undefined
      ? {
          fullAccess: change.enabled,
          enabledAt: clock(),
          enabledBy: change.by,
        }
      : change.enabled
        ? enableFullAccess(store, change.by, clock)
        : disableFullAccess(store, change.by, clock);
  appendToLedger(
    auditLedgerDirFor(change.workspace),
    change.enabled
      ? fullAccessEnabledAudit({
          sessionId: change.sessionId,
          command: change.by,
          workspace: change.workspace,
        })
      : fullAccessDisabledAudit({
          sessionId: change.sessionId,
          command: change.by,
          workspace: change.workspace,
        }),
    change.onAuditError,
  );
  return posture;
}

// The ONE enable path for session-scoped full access: `kubic`,
// `kubic tui`, `kubic run` and `kubic sessions create` all come through
// here. It records the posture in the session dir (never in
// config), appends one audit row naming the session and the originating
// command, and returns the warning the caller prints on stderr.
export function enableSessionFullAccess(
  options: SessionFullAccessOptions,
): SessionFullAccessGrant {
  const commandLine = `kubic ${options.command} ${FULL_ACCESS_FLAG}`;
  const posture = recordFullAccessChange({
    enabled: true,
    by: commandLine,
    sessionId: options.sessionId,
    workspace: options.workspace,
    ...(options.sessionDir === undefined
      ? {}
      : { sessionDir: options.sessionDir }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onAuditError === undefined
      ? {}
      : { onAuditError: options.onAuditError }),
  });
  return {
    posture,
    warning: `full-access approvals skipped for session ${options.sessionId} (recorded ${posture.enabledAt}) — every challenged call runs without asking`,
  };
}

// The warning a headless run prints when the session it runs in already has
// full access: a scripted caller must never be surprised.
export function fullAccessInForceWarning(sessionId: string): string {
  return `session ${sessionId} runs with full access: approvals are skipped for every challenged call`;
}

// The INSTALLED policy. This is the
// single derivation both the lane boot and `kubic doctor` read, so
// agreement between what doctor prints and what the lane enforces holds by
// construction instead of by two hand-kept copies.
//
// Deny-by-default doctrine, stated once here:
// - classes: the explicit, documented safe default is DEFAULT_PERMISSIONS
//     — filesystem workspace-write, shell true, network none,
//     git workspace, credentials none. Config-sourced classes REPLACE the
//     default when the config layer supplies them; the restrictive tail
//     (network none, credentials none) is what makes the default safe.
//   - interceptors: destructive + network + confinement guards are ALWAYS
//     installed, with the approval ask wired, so a destructive command in a
//     non-interactive run is refused rather than executed. `workspace` is
//     the confinement root: the lane cannot invent one, so it is explicit.
//   - contributions: the telemetry wrapper is appended LAST, which makes it
//     outermost — it therefore times (and records) a DENIED attempt too.
//     The permission wrapper is composed by the lane itself, innermost, from
// the same classes (boot.ts withPolicyContributions) — never duplicated
//     here.
export interface PolicyInput {
  workspace: string;
  /** Config-sourced classes; absent means the documented DEFAULT_PERMISSIONS. */
  classes?: PermissionClasses;
  /**
   * Role-sourced approval obligations: tool names
   * that always require approval under the resolved role — the union of
   * the role document's `requires` and every config `[roles.<name>]`
   * layer's. Threaded into the installed trigger context; absent means
   * none (the triggers alone decide).
   */
  requires?: string[];
  /**
   * Where the classes came from, as the CONFIG LAYER recorded it. Absent
   * falls back to the shape rule (classes present ⇒ 'config'), which is what
   * legacy callers mean; the composition root always passes the layer's own
   * answer, so a config-less install is never printed as 'config'.
   */
  source?: 'config' | 'default';
  /** Extension/facet contributions; telemetry composes outermost of them. */
  contributions?: ToolContribution[];
  /** Home directory holding the global `~/.kubic` (default os.homedir()). */
  home?: string;
  /** The session root in use; writes into it are refused. */
  sessionsRoot?: string;
  /** Telemetry sink; absent means no telemetry wrapper. */
  telemetry?: (record: { toolName: string; durationMs: number }) => void;
  /** Bounded approval wait (headless never answers; it denies on timeout). */
  maxPendingMs?: number;
  /** The approval route the shipped default runs on. */
  route?: 'ask-user' | 'deny';
  /** Stored decisions are scoped to one session (the shipped default). */
  sessionScoped?: boolean;
  /**
   * Config `[approvals] autoApprove`: capabilities approved
   * without an ask. Explicit-only — it arrives from config, never from the
   * tool path — and it is consulted before the no-surface refusal, so a
   * headless run honours it too.
   */
  autoApprove?: Capability[];
  /** Config `[approvals] requireJustification`. */
  requireJustification?: boolean;
  /** Session dir carrying posture.json (session-scoped full access). */
  sessionDir?: string;
  /**
   * The answer seat: the command's own surface for collecting a
   * verdict on a challenged call. Attached only by commands with a user
   * attached (`kubic tui`); absent means the immediate no-surface refusal
   * below, which is what every headless run keeps. An ask that resolves
   * `undefined` is a seat that could not answer — the service's own
   * maxPendingMs bound denies it rather than hanging the turn.
   */
  answer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
  /** Audit identity: the session (absent: sessionDir's basename). */
  sessionId?: string;
  /**
   * Audit identity: the `provider/id` the lane runs on. A function is read at
   * RECORD time, so a policy installed before the lane boots (the stored-model
   * rule) or a model switched mid-session (`/model`) is still recorded under
   * the model the lane runs now.
   */
  model?: string | (() => string);
  /**
   * Audit identity: the thinking level the lane runs. A
   * function is read at RECORD time, like the model — the policy is
   * installed before the lane boots, and `/thinking` can change it
   * mid-session. Absent keeps the honest `unknown`.
   */
  thinking?: string | (() => string | undefined);
  /**
   * Audit identity: the base revision the run started
   * from (`git rev-parse HEAD` captured once at run start, `none` outside
   * git). The composition root resolves it; the policy only carries it.
   */
  base?: string;
  /** A failed ledger append lands here; it never reaches the approval. */
  onAuditError?: (message: string) => void;
}

// The config `[approvals]` half of the install: the one shape
// the composition root projects from the config load and every entry
// point (run, tui, replay, doctor) spreads into installPolicy.
export type ApprovalConfig = Pick<
  PolicyInput,
  | 'route'
  | 'maxPendingMs'
  | 'autoApprove'
  | 'requireJustification'
  | 'sessionScoped'
>;

// What the lane installed and what doctor must print, in ONE object.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: PermissionClasses;
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  autoApprove: string[];
  requireJustification: boolean;
  fullAccess: boolean;
  // Every declared level the tool set cannot express,
  // with the level the lane enforces instead — reported, never silent.
  unsupported: UnsupportedLevel[];
}

interface RecordedApprovalDeny {
  capability: string;
  toolName: string;
  reason: string;
}

// The named reason a challenged call is refused with while no surface can
// collect a verdict. Named once, here, so the block reason and the headless
// run's terminus say the same sentence.
export const NO_ANSWER_SURFACE_REASON =
  'approval required, but no approval surface is installed on this command: kubic run has no ask prompt, so the call is refused; answer approvals in kubic tui, or change the approval route or policy';

export interface InstalledPolicy {
  classes: PermissionClasses;
  interceptors: PolicyInterceptorOptions;
  contributions: ToolContribution[];
  posture: InstalledPolicyPosture;
  // Approvals this policy refused, in order. The composition root reads this
  // after a drive: a headless run that hit an unanswerable approval must end
  // as an approval terminus — approval_denied for an explicit refusal,
  // approval_timed_out when the reason carries the timeout marker (both exit
  // 4) — never as a silent success.
  denials: () => RecordedApprovalDeny[];
  // The decider, exposed so a caller (or a test) can drive it directly.
  ask: ApprovalAsk;
  // The end-of-session posture check — a posture.json written
  // after the last ask is restored and recorded before the session closes.
  settle?: () => void;
  // True exactly when the ask above auto-approves every
  // challenged call as full access — the boot posture the ask
  // itself decides on, so the indicator cannot drift from the policy.
  approvalsSkipped: () => boolean;
  // The in-session toggle. Flips the LIVE posture the
  // next ask reads, writes posture.json through the same helpers the CLI
  // uses, appends the audit row, and re-bases the guard on the new
  // posture (the operator's own change is not a foreign one). Returns the
  // recorded posture; throws only when the posture file cannot be written
  // (the caller reports it, the in-memory posture stays put).
  setFullAccess?: (enabled: boolean, by: string) => AccessPosture;
  // The turn ended — an `allow all edits this turn` answer
  // stops applying. And whether one applies right now (the status line).
  endTurn?: () => void;
  editsApprovedThisTurn?: () => boolean;
}

export function installedPolicyPosture(
  input: PolicyInput,
  // The posture record read at boot; absent reads it here.
  bootPosture?: AccessPosture,
): InstalledPolicyPosture {
  const classes = validateClasses({ ...(input.classes ?? {}) });
  const allowlist = toolsForClasses(classes);
  // The derived allowlist must agree with the classes it came from —
  // a contradictory pair is refused by name here, never printed green.
  const agreement = checkAgreement(classes, allowlist);
  if (!agreement.agree) {
    throw new PolicyValidationError(
      `installed policy contradicts itself: ${agreement.reason}`,
    );
  }
  // One validation for every approval knob: the same
  // validatePolicy the config load and the service use, so the posture
  // doctor prints is exactly the policy the service enforces.
  const policy = validatePolicy({
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.maxPendingMs === undefined
      ? {}
      : { maxPendingMs: input.maxPendingMs }),
    ...(input.autoApprove === undefined
      ? {}
      : { autoApprove: input.autoApprove }),
    ...(input.sessionScoped === undefined
      ? {}
      : { sessionScoped: input.sessionScoped }),
    ...(input.requireJustification === undefined
      ? {}
      : { requireJustification: input.requireJustification }),
  });
  const fullAccess =
    bootPosture?.fullAccess ??
    (input.sessionDir === undefined
      ? false
      : new FileApprovalStore(input.sessionDir).loadPosture().fullAccess);
  return {
    // The layer's own answer when the caller supplies it (the composition
    // root does); the shape rule only as the legacy fallback, so the printed
    // source is never a guess about a config-less install.
    source:
      input.source ?? (input.classes === undefined ? 'default' : 'config'),
    route: policy.route,
    classes: { ...classes },
    allowlist: [...allowlist],
    // Named mechanisms, not adjectives: this is exactly what the lane
    // registers (registerPolicyInterceptors) plus the execute-time wrapper
    // the lane composes from `classes`.
    interceptors: [
      'permission-wrapper',
      'destructive-guard',
      'network-guard',
      'confine-guard',
      'approval',
    ],
    sessionScoped: policy.sessionScoped,
    maxPendingMs: policy.maxPendingMs,
    autoApprove: [...policy.autoApprove],
    requireJustification: policy.requireJustification,
    fullAccess,
    unsupported: checkExpressible(classes),
  };
}

export function installPolicy(input: PolicyInput): InstalledPolicy {
  const denials: RecordedApprovalDeny[] = [];
  const store =
    input.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(input.sessionDir);
  // The full-access posture is resolved ONCE, here,
  // at session boot — from what the explicit flag or `sessions create
  // --dangerously-skip-approvals` recorded — and kept in memory. posture.json
  // is never re-read to decide an ask.
  const bootPosture: AccessPosture = store?.loadPosture() ?? {
    fullAccess: false,
  };
  const posture = installedPolicyPosture(input, bootPosture);
  const service = new ApprovalService({
    policy: validatePolicy({
      route: posture.route,
      sessionScoped: posture.sessionScoped,
      maxPendingMs: posture.maxPendingMs,
      autoApprove: posture.autoApprove,
      requireJustification: posture.requireJustification,
    }),
    ...(store === undefined ? {} : { store }),
    // The seat's ask is the service's awaitAnswer: the service races it
    // against its own maxPendingMs bound, so a seat that never resolves
    // denies on timeout (never hangs) exactly like the headless path.
    ...(input.answer === undefined ? {} : { awaitAnswer: input.answer }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  // Audit ledger: every resolved ask appends one record to the REPO
  // ledger: <main checkout>/.kubic/audit,
  // resolved once here with the same resolver `kubic audit` reads through,
  // so a run from a subdirectory or a linked worktree writes where the
  // reader looks. Best-effort by contract — a failed write (or a malformed
  // record) goes to onAuditError, never into the approval decision.
  const ledgerDir = auditLedgerDirFor(input.workspace);
  const auditSessionId =
    input.sessionId ??
    (input.sessionDir === undefined ? '' : basename(input.sessionDir));
  const audit = (
    toolName: string,
    trigger: string,
    decision:
      | { approved: true; by?: string }
      | { approved: false; reason: string },
    fullAccess: boolean,
    // What an approval's record says beyond `approved` (an
    // edited command names both).
    note?: string,
  ): void => {
    const onError = input.onAuditError ?? (() => undefined);
    try {
      const model =
        typeof input.model === 'function' ? input.model() : input.model;
      // The thinking level at record time, like the model.
      const thinking =
        typeof input.thinking === 'function'
          ? input.thinking()
          : input.thinking;
      appendToLedger(
        ledgerDir,
        decisionAudit({
          sessionId: auditSessionId,
          toolName,
          trigger,
          workspace: input.workspace,
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
          ...(input.base === undefined ? {} : { base: input.base }),
          approved: decision.approved,
          ...(decision.approved
            ? decision.by === undefined
              ? {}
              : { by: decision.by }
            : { reason: decision.reason }),
          ...(note === undefined ? {} : { note }),
          posture: fullAccess ? 'full-access' : 'approvals',
        }),
        onError,
      );
    } catch (error) {
      try {
        onError(error instanceof Error ? error.message : String(error));
      } catch {
        // A throwing error sink must not reach the approval either.
      }
    }
  };
  // Kubic state beyond the workspace: the global home and the
  // session root this lane actually writes.
  const controlPlane: ControlPlaneRoots = {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.sessionsRoot === undefined
      ? {}
      : { sessionsRoot: input.sessionsRoot }),
  };
  const deny = (
    capability: string,
    toolName: string,
    reason: string,
  ): { approved: false; reason: string } => {
    denials.push({ capability, toolName, reason });
    audit(toolName, capability, { approved: false, reason }, false);
    return { approved: false, reason };
  };
  // True exactly when the ask auto-approves every challenged call as full
  // access — the SAME live posture the ask consults, so the status bar's OFF
  // indicator cannot drift from the policy.
  const approvalsSkipped = (): boolean =>
    posture.fullAccess && posture.route === 'ask-user';
  // The in-session toggle. `posture.fullAccess` is the
  // LIVE cell the ask reads on every call, so flipping it takes effect on
  // the very next challenged call; `bootPosture` is re-based with it, so the
  // Guard sees the operator's own change rather than a foreign one and
  // does not restore the file underneath them.
  const setFullAccess = (enabled: boolean, by: string): AccessPosture => {
    // ONE writer and ONE clock read: the helper writes
    // the file and the audit row through the same shapes the CLI paths use,
    // and the record it returns is what the live cell and the guard's
    // baseline are re-based on — never a second `Date.now()`.
    const recorded = recordFullAccessChange({
      enabled,
      by,
      sessionId: auditSessionId,
      workspace: input.workspace,
      ...(store === undefined ? {} : { store }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.onAuditError === undefined
        ? {}
        : { onAuditError: input.onAuditError }),
    });
    posture.fullAccess = recorded.fullAccess;
    bootPosture.fullAccess = recorded.fullAccess;
    bootPosture.enabledAt = recorded.enabledAt;
    bootPosture.enabledBy = recorded.enabledBy;
    return recorded;
  };
  // A posture.json change made DURING the session is refused:
  // the file is restored to the boot posture (so a later resume does not
  // inherit it) and the change is recorded once in the ledger. Checked on
  // every ask and on settle(), never consulted for the decision itself.
  let postureChangeRecorded = false;
  const guardPosture = (): void => {
    if (store === undefined) return;
    let current: AccessPosture;
    try {
      current = store.loadPosture();
    } catch {
      return;
    }
    if (
      current.fullAccess === bootPosture.fullAccess &&
      current.enabledAt === bootPosture.enabledAt &&
      current.enabledBy === bootPosture.enabledBy
    ) {
      return;
    }
    const onError = input.onAuditError ?? (() => undefined);
    try {
      store.savePosture(bootPosture);
    } catch (error) {
      onError(
        `posture restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (postureChangeRecorded) return;
    postureChangeRecorded = true;
    appendToLedger(
      ledgerDir,
      postureChangedAudit({
        sessionId: auditSessionId,
        workspace: input.workspace,
        bootFullAccess: bootPosture.fullAccess,
        observedFullAccess: current.fullAccess === true,
      }),
      onError,
    );
  };
  // The operator approved this turn's edits at once (`A`): an
  // edit or write whose challenge is its role obligation runs without asking
  // until the turn ends — never latched, never another capability (a path
  // outside the workspace raises `outside-write`, which still asks).
  let turnEdits = false;
  const turnEditable = (toolName: string, capability: string): boolean =>
    (toolName === 'edit' || toolName === 'write') &&
    capability === `requires:${toolName}`;
  const ask: ApprovalAsk = (call) => judge(call, 0);
  const judge = async (
    call: ApprovalCall,
    edits: number,
  ): Promise<ApprovalAskVerdict> => {
    // A posture.json change made mid-session is refused and
    // restored before this call is judged.
    guardPosture();
    // Refused control-plane state: a tool error before any
    // posture is consulted — full access included — and never an ask.
    const refusal = controlPlaneRefusal(
      call.toolName,
      call.args,
      input.workspace,
      controlPlane,
    );
    if (refusal !== undefined) {
      return deny(KUBIC_STATE_WRITE, call.toolName, refusal);
    }
    const detected = detectTriggers(
      call.toolName,
      call.args,
      // The role's approval obligations challenge
      // here, alongside the class-derived triggers.
      triggerContextFor(
        posture.classes,
        input.workspace,
        controlPlane,
        undefined,
        input.requires,
      ),
    );
    let capabilities = detected;
    if (posture.fullAccess && posture.route === 'ask-user') {
      // Full access never answers an always-ask capability:
      // those still go through the ask below; everything else is approved.
      capabilities = detected.filter((capability) =>
        ALWAYS_ASK.has(capability),
      );
      // Record exactly what full access waived — one record per
      // capability, posture 'full-access' — and nothing at all for an
      // untriggered call. The single `trigger:full-access` row this replaces
      // was written for EVERY call, read and ls included: one fsync per tool
      // call, and a trail that could not name what ran unapproved.
      for (const capability of detected) {
        if (ALWAYS_ASK.has(capability)) continue;
        audit(
          call.toolName,
          capability,
          { approved: true, by: 'full-access' },
          true,
        );
      }
      if (capabilities.length === 0) {
        // An untriggered call waived nothing, so it is not challenged and no
        // guard needs standing down.
        return { approved: true, challenged: detected.length > 0 };
      }
    }
    if (capabilities.length === 0) return { approved: true, challenged: false };
    for (const capability of capabilities) {
      const key = approvalKey(call.toolName, capability, call.args);
      // A stored decision (a real answer, from a surface that has one) wins:
      // first-answer-latched, exactly like every other approval path.
      // A stored approval granted without justification does not survive
      // requireJustification (the service's own staleness rule): it
      // re-enters the policy path below instead of being replayed.
      const stored = service.decided(key);
      const decided =
        stored?.approved === true &&
        posture.requireJustification &&
        stored.justified !== true
          ? undefined
          : stored;
      if (decided !== undefined) {
        if (!decided.approved) {
          return deny(capability, call.toolName, decided.reason);
        }
        audit(
          call.toolName,
          capability,
          { approved: true, by: decided.by },
          false,
        );
        continue;
      }
      // route=deny refuses everything challenged — autoApprove entries never
      // apply under it, which is exactly what `kubic doctor` says (`route=deny
      // ignores autoApprove`); the lane never approves them.
      if (posture.route === 'deny') {
        // Configured refusal: named as the route, never as a timeout.
        const reason = `denied by policy route (capability: ${capability})`;
        return deny(capability, call.toolName, reason);
      }
      // This turn's edits were approved at once.
      if (turnEdits && turnEditable(call.toolName, capability)) {
        audit(
          call.toolName,
          capability,
          { approved: true, by: ALLOW_TURN_EDITS },
          false,
        );
        continue;
      }
      // Config autoApprove: explicit-only, decided by
      // the service (which also enforces requireJustification), and
      // consulted BEFORE the no-surface refusal, so a headless run honours it
      // exactly like an interactive one. An always-ask capability never takes
      // this branch: it behaves as if autoApprove were empty for
      // it — the seat below, or the instant no-surface refusal — instead of
      // waiting out maxPendingMs with no seat to answer.
      if (
        !ALWAYS_ASK.has(capability) &&
        posture.autoApprove.includes(capability)
      ) {
        const verdict = await service.request({
          key,
          capability,
          toolName: call.toolName,
          summary: summarizeRequest(call.toolName, capability, call.args),
        });
        if (!verdict.approved) {
          return deny(capability, call.toolName, verdict.reason);
        }
        audit(
          call.toolName,
          capability,
          { approved: true, by: verdict.by },
          false,
        );
        continue;
      }
      // An answer seat is attached: the TUI is a command with a
      // user attached, so the verdict can be collected instead of refused.
      // The wait is bounded by maxPendingMs inside the service — a seat that
      // never answers denies on timeout rather than hanging the turn.
      if (input.answer !== undefined) {
        // An ask carries the file change it would make.
        const preview = approvalPreview(
          createNodeFileBridge(input.workspace),
          call.toolName,
          call.args,
        );
        // The answers an ask can take beyond allow/deny.
        const editable =
          call.toolName === 'bash' && typeof call.args.command === 'string';
        const batchable = turnEditable(call.toolName, capability);
        const verdict = await service.request({
          key,
          capability,
          toolName: call.toolName,
          ...approvalRequestDisplay(call.toolName, capability, call.args),
          ...(preview === undefined ? {} : { preview }),
          ...(editable ? { editable: true } : {}),
          ...(batchable ? { batchable: true } : {}),
        });
        if (!verdict.approved) {
          // A denial's reason reaches the model (a user's comment rides it):
          // bounded like every other summary.
          const reason = boundedNote(verdict.reason);
          return deny(capability, call.toolName, reason);
        }
        // The operator rewrote the command. The rewrite is a new
        // call: judged again from the start (a destructive edit asks again),
        // and what runs is the rewrite.
        if (verdict.edited !== undefined && editable) {
          const command = verdict.edited.command;
          if (command.trim() === '') {
            return deny(
              capability,
              call.toolName,
              'denied by the user: the edited command is empty',
            );
          }
          if (edits >= MAX_APPROVAL_EDITS) {
            return deny(
              capability,
              call.toolName,
              `denied: one call was edited more than ${MAX_APPROVAL_EDITS} times`,
            );
          }
          audit(
            call.toolName,
            capability,
            { approved: true, by: 'user-edit' },
            false,
            boundedNote(
              redactSecretShapes(
                `edited by the user: ${String(call.args.command)} → ${command}`,
              ),
            ),
          );
          const editedArgs = { ...call.args, command };
          const next = await judge({ ...call, args: editedArgs }, edits + 1);
          return next.approved
            ? { ...next, arguments: next.arguments ?? editedArgs }
            : next;
        }
        if (verdict.by === ALLOW_TURN_EDITS && batchable) turnEdits = true;
        audit(
          call.toolName,
          capability,
          { approved: true, by: verdict.by },
          false,
        );
        continue;
      }
      // NO ANSWER SURFACE IS INSTALLED — `kubic run` has no TTY, and a `kubic
      // tui` whose seat was never attached cannot collect a verdict either.
      // Waiting maxPendingMs for an answer that cannot arrive would be a
      // silent hang and a 60s stall per dangerous call; the honest default is
      // to refuse immediately and RECORD the refusal, so the composition root
      // ends the run as approval_denied (exit 4, — this refusal carries no
      // timeout marker) instead of reporting a success the user never
      // approved. The refusal is deliberately NOT
      // persisted: it is a missing surface, not a user decision, and a later
      // overlay must still be able to ask about the same operation.
      const reason = `${NO_ANSWER_SURFACE_REASON} (capability: ${capability})`;
      return deny(capability, call.toolName, reason);
    }
    return { approved: true, challenged: true };
  };
  const contributions = [...(input.contributions ?? [])];
  if (input.telemetry !== undefined) {
    // Outermost by construction: appended last, so it wraps whatever the
    // caller contributed and the lane's own permission(core) stack.
    contributions.push(withTelemetry(input.telemetry));
  }
  return {
    classes: posture.classes,
    interceptors: {
      workspace: input.workspace,
      shell: posture.classes.shell,
      network: posture.classes.network,
      approve: ask,
    },
    contributions,
    posture,
    denials: () => [...denials],
    ask,
    approvalsSkipped,
    setFullAccess,
    settle: guardPosture,
    endTurn: () => {
      turnEdits = false;
    },
    editsApprovedThisTurn: () => turnEdits,
  };
}

// How many times one call may be rewritten before it is refused
// (every rewrite is an operator's answer; the bound is a backstop).
const MAX_APPROVAL_EDITS = 8;

// A seat's free text (a denial comment, a note) as the policy
// records and the model reads it: one line, bounded.
function boundedNote(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const max = APPROVAL_NOTE_MAX_CHARS + 64;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

// The trigger context the shipped default evaluates capabilities with: the
// same classifiers the agent guards use, so the approval
// decision and the guard that blocks the call can never disagree.
export function triggerContextFor(
  classes: PermissionClasses,
  workspace: string,
  controlPlaneOrHome?: ControlPlaneRoots | string,
  home?: string,
  // Role-sourced approval obligations — tool names
  // that always challenge under the resolved role. Optional, so the
  // existing call shapes (and their tests) are untouched.
  requires?: string[],
): TriggerContext {
  // HEAD passes the control plane as the third argument; the
  // branch passes the user's home string there (tests rely on both shapes),
  // so the third argument is either. `home` is always set — `~`-expanded
  // targets are checked against it.
  const controlPlane =
    typeof controlPlaneOrHome === 'string' ? undefined : controlPlaneOrHome;
  const resolvedHome =
    typeof controlPlaneOrHome === 'string'
      ? controlPlaneOrHome
      : (home ?? homedir());
  return {
    workspace,
    home: resolvedHome,
    ...(controlPlane === undefined ? {} : { controlPlane }),
    ...(requires === undefined ? {} : { requires: [...requires] }),
    network: classes.network,
    credentials: classes.credentials,
    isDestructive: defaultIsDestructive,
    isNetworkCommand,
    isOutsideWorkspace: (path: string) =>
      confinePath(workspace, path).rewritten,
  };
}

export interface ApprovalServiceOptions {
  policy: ApprovalPolicy;
  store?: ApprovalStore;
  // Resolves the pending request when a user answers. Never resolves on
  // its own in headless runs — the wait below times out into a denial.
  //
  // The service hands the seat an AbortSignal and aborts it when
  // its own bound expires. A surface that honours it withdraws the obsolete
  // question instead of leaving a modal nobody can answer; a seat that
  // ignores the signal still works — the race below is what decides.
  awaitAnswer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
}

export class ApprovalService {
  private readonly policy: ApprovalPolicy;
  private readonly store: ApprovalStore;
  private readonly awaitAnswer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  private readonly decisions: Map<string, ApprovalVerdict>;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<
    string,
    (verdict: ApprovalVerdict | undefined) => void
  >();

  constructor(options: ApprovalServiceOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new MemoryApprovalStore();
    this.awaitAnswer = options.awaitAnswer;
    this.decisions = new Map(Object.entries(this.store.load()));
  }

  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  decided(key: string): ApprovalVerdict | undefined {
    return this.decisions.get(key);
  }

  // First answer wins: a stored decision is returned untouched and a late
  // submit for a settled key is ignored (memoOnce semantics) — EXCEPT a
  // stored approval that predates a tightened policy: an approval granted
  // without justification does not survive requireJustification being
  // enabled later. It re-enters the policy path (and denies headless).
  submit(request: ApprovalRequest, verdict: ApprovalVerdict): ApprovalVerdict {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (
      this.policy.requireJustification &&
      verdict.approved &&
      request.justification === undefined
    ) {
      return { approved: false, reason: 'approval requires justification' };
    }
    const stamped: ApprovalVerdict = verdict.approved
      ? { ...verdict, justified: request.justification !== undefined }
      : verdict;
    // Only session-scoped answers enter the latch —
    // allow-session, autoApprove, the route, and user DENIALS (a refusal
    // latching is the fail-safe direction: the user said no to this exact
    // operation for this session). An 'allow once' approves THIS call only:
    // it is returned without being stored or persisted, so the next
    // identical call asks again.
    // A turn's edit batch is not a session answer either.
    if (
      !(
        stamped.approved &&
        (stamped.by === ALLOW_ONCE ||
          stamped.by === ALLOW_TURN_EDITS ||
          stamped.edited !== undefined)
      )
    ) {
      this.decisions.set(request.key, stamped);
      this.persist();
    }
    this.pending.delete(request.key);
    this.waiters.get(request.key)?.(stamped);
    this.waiters.delete(request.key);
    return stamped;
  }

  async request(request: ApprovalRequest): Promise<ApprovalVerdict> {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) {
      const stale =
        existing.approved &&
        this.policy.requireJustification &&
        existing.justified !== true;
      if (!stale) return existing;
      // Evict: the stored approval predates the tightened policy and must
      // re-enter the policy path (submit's first-wins latch would otherwise
      // hand it straight back). Every path below ends in submit, which
      // persists — so the eviction is durable and the denial is recorded.
      this.decisions.delete(request.key);
    }
    // route=deny first: autoApprove entries never apply under it.
    if (this.policy.route === 'deny') {
      return this.submit(request, {
        approved: false,
        reason: `denied by policy route (capability: ${request.capability})`,
      });
    }
    if (
      this.policy.autoApprove.includes(request.capability) &&
      !ALWAYS_ASK.has(request.capability)
    ) {
      if (
        this.policy.requireJustification &&
        request.justification === undefined
      ) {
        return this.submit(request, {
          approved: false,
          reason: 'approval requires justification',
        });
      }
      return this.submit(request, { approved: true, by: 'autoApprove' });
    }
    this.pending.set(request.key, request);
    try {
      const answer = await this.waitForAnswer(request);
      if (answer === undefined) {
        // A timeout is an unanswered question, not a decision.
        // Deny THIS call (bounded, named) but persist nothing — a missed
        // dialog must not latch a denial that no later surface can overturn.
        // submit()'s first-wins latch is reserved for real answers (user,
        // route, autoApprove); a repeated ask waits the full bound again.
        return {
          approved: false,
          reason: `approval ${TIMEOUT_REASON_MARKER} after ${this.policy.maxPendingMs}ms`,
        };
      }
      return this.submit(request, answer);
    } finally {
      this.pending.delete(request.key);
    }
  }

  private waitForAnswer(
    request: ApprovalRequest,
  ): Promise<ApprovalVerdict | undefined> {
    // The bound that denies the call is the bound that withdraws
    // the QUESTION. Without this the surface kept showing an ask the service
    // had already given up on: the TUI dialog stayed up (and blocked the next
    // one).
    const controller = new AbortController();
    const answer = this.awaitAnswer?.(request, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        // Resolve the BOUND first, then withdraw the question: the abort makes
        // the seat resolve too (with its cancelled verdict), and the race must
        // settle on the timeout — otherwise a withdrawal would latch a denial
        // the user never gave.
        resolve(undefined);
        controller.abort();
      }, this.policy.maxPendingMs);
      timer.unref?.();
    });
    const notified = new Promise<ApprovalVerdict | undefined>((resolve) => {
      this.waiters.set(request.key, resolve);
    });
    const done = (
      value: ApprovalVerdict | undefined,
    ): ApprovalVerdict | undefined => {
      if (timer !== undefined) clearTimeout(timer);
      this.waiters.delete(request.key);
      return value;
    };
    if (answer === undefined) return timeout.then(done);
    return Promise.race([answer, timeout, notified]).then(done);
  }

  private persist(): void {
    this.store.save(Object.fromEntries(this.decisions));
  }
}
