import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PermissionClasses } from '../../agents/src/policy.js';
import {
  checkAgreement,
  toolsForClasses,
  validateClasses,
} from '../../agents/src/policy.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import type {
  PolicyInterceptorOptions,
  PolicyTrigger,
} from '../../worker/src/lane/interceptors.js';
import {
  confinePath,
  defaultIsDestructive,
  isNetworkCommand,
  redactReason,
} from '../../worker/src/lane/interceptors.js';
import type { ToolContribution } from '../../worker/src/lane/wrap.js';
import { withTelemetry } from '../../worker/src/lane/wrap.js';
import { TIMEOUT_REASON_MARKER } from './orchestrator/approvals/timeout-reason.js';
// Approval triggers, policy, and durable decider service (issue #16; §41).
// The decider is the user — never a manager, never the model. There is no
// manager-approval path in solo: this module exposes no role/manager
// override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (first-wins latch, the memoOnce
// semantic — the harness primitive itself is not involved). Same-process
// late attach discovers pending asks via pendingRequests(); across a
// restart, pending asks time out to deny by design — only settled
// decisions persist (approvals.json), never open questions. A timeout
// denies the call but stores NOTHING (issue #110): it is an unanswered
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
  'budget-overrun',
  'spawn-agents',
  'privilege-escalation',
] as const;

export type Capability = (typeof CAPABILITIES)[number] | string;

export interface ApprovalPolicy {
  route: 'ask-user' | 'deny';
  autoApprove: Capability[];
  sessionScoped: boolean;
  maxPendingMs: number;
  requireJustification: boolean;
}

export class PolicyValidationError extends Error {
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
  justification?: string;
}

export type ApprovalVerdict =
  | { approved: true; by: string; justified?: boolean }
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

// Trigger detection (§41.1). Predicates are injected so this module stays
// free of shell parsing: the worker owns the classifiers (issue #15) and
// the host owns the decision. The bash detectors are a literal-pattern
// heuristic, not a sandbox (issue #131): redirect/tee/cp-mv-install
// outside-writes, `sudo` privilege escalation, and destructive/network
// verbs behind command indirection. Indirection coverage, exactly:
// `$(…)` spans (balanced-paren scan, nested substitutions included; the
// scan tracks at most MAX_UNWRAP_DEPTH real openers and its unmatched
// markers still consume closers, so the effective nesting threshold is
// ~2x the cap), backtick spans, and `eval` segments are unwrapped to
// a fixpoint, so `eval $(rm -rf /)` and `echo $(echo $(rm -rf /))` raise
// too, not only the single-level `$(rm -rf /)`. What still bypasses them —
// stated, not silent: interpreter-based verbs handed over as data
// (`bash -c`, `python3 -c`, `node -e`), substitutions nested past
// ~2x MAX_UNWRAP_DEPTH, python/node/npm exfiltration under network:none,
// quoted or backslash-obfuscated verbs the literal patterns cannot see,
// whitespace tricks around redirection targets, and flag-reordered copy
// targets (`cp -t /etc a b`) the last-argument heuristic misses. Detector
// ownership for the rest:
//   credentials overreach, spawn-agents — no detector: fire only via an
//     explicit `requires` entry, or via their owners (credentials with
//     issue #19 git/credential tools, spawn-agents with the orchestrator).
//   budget/concurrency overrun — the `budgetOverrun` flag; no live
//     producer yet (orchestrator opt-in budgets #48, worker perf budgets
//     #55). Until one wires up, the flag is test-only: documented, silent
//     nowhere.
//   network under allowlist/full — fires nothing by design (issue #15:
//     no network tool exists to remove; the flag is advisory for #16).
//   sensitive reads — deliberately not a trigger: §41.1 governs writes,
//     the filesystem read class governs reads.
export interface TriggerContext {
  workspace: string;
  network: 'none' | 'allowlist' | 'full';
  isDestructive: (command: string, workspace: string) => boolean;
  isNetworkCommand: (command: string) => boolean;
  isOutsideWorkspace: (path: string) => boolean;
  requires?: string[];
  budgetOverrun?: boolean;
}

const GIT_PUSH = /^\s*git\s+push\b/i;
const GIT_REMOTE_MUTATION = /^\s*git\s+remote\s+(add|set-url|remove|rename)\b/i;
const INSTALL =
  /(^|[|;&\s])(npm\s+(i|install|add|clean-install)|pip(3)?\s+install|brew\s+install|apt(-get)?\s+install|cargo\s+(install|add)|go\s+install)\b/i;
const DEPLOY =
  /(^|[|;&\s])(kubectl\s+(apply|create|delete|rollout)|docker\s+push|terraform\s+apply|gh\s+release\s+create)\b/i;
// Shell redirection into an absolute target is a write by another name —
// `echo x > /etc/cron.d/x` must raise outside-write like the write tool.
const REDIRECT = /(^|[|;&\s])[^|;&]*>{1,2}\s*(\S+)/;
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
// Privilege escalation is a capability event on its own (issue #131):
// `sudo systemctl restart …` is dangerous-shaped whatever verb follows.
// Word-boundary, anywhere in the raw command — quoted context included,
// because a literal scan cannot see into quotes — and over-triggering is
// the documented, safe direction: a raised capability becomes an ask,
// never a silent grant.
const SUDO = /\bsudo\b/;
// Command indirection (issue #131): a destructive/network verb inside
// `$(…)`, backticks, or after `eval` raises the UNDERLYING capability
// instead of staying silent. The matcher layer documents indirection as
// unenforceable for its guards — detection is cheaper than enforcement
// and the ask is the safety net. `$(…)` is collected with a bounded
// balanced-paren scan (nested substitutions included), and every wrapper
// form unwraps to a fixpoint: `eval $(rm -rf /)`, `echo $(echo $(rm -rf
// /))`, and backtick-wrapped `$(rm -rf /)` all raise, not only the
// single-level `$(rm -rf /)` the first cut handled. Stated bound: nesting
// deeper than ~2x MAX_UNWRAP_DEPTH stays unraised — the unmatched-opener
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

// Every wrapper cue in the raw command: balanced `$(…)` spans (nested ones
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
// trimming it would silently widen what counts as inside — the fix-cycle-2
// security re-review measured exactly that (outside → inside flip, an ask
// became a silent grant). The ONLY delimiter trim in this module is the
// span-closer trim in targetToken, scoped to tokens actually lifted out of
// a `$(…)` span.
function stripQuotes(target: string): string {
  return target.replace(/^['"]+/, '').replace(/['"]+$/, '');
}

// The write target of a detector segment: the last whitespace-separated
// token (last-argument heuristic; segmentEnd is the segment's absolute end
// index in the raw command, so token characters tie back to command
// positions). Quotes always come off (shell syntax). A trailing delimiter
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
  return stripQuotes(raw.slice(0, raw.length - cut));
}

export function detectTriggers(
  toolName: string,
  args: Record<string, unknown>,
  ctx: TriggerContext,
): Capability[] {
  const found: Capability[] = [];
  if (ctx.requires?.includes(toolName) === true) {
    found.push(`requires:${toolName}`);
  }
  if (ctx.budgetOverrun === true) {
    found.push('budget-overrun');
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
    if (ctx.network === 'none' && ctx.isNetworkCommand(command))
      found.push('network');
    if (GIT_PUSH.test(command) || GIT_REMOTE_MUTATION.test(command))
      found.push('git-push');
    if (INSTALL.test(command)) found.push('install');
    if (DEPLOY.test(command)) found.push('deploy');
    const redirect = REDIRECT.exec(command);
    if (redirect !== null && redirect[2] !== undefined) {
      // Targets arrive raw: quotes always come off, and a lifted token also
      // loses its substitution closer (targetToken) — so `> "/etc/cron.d/x"`
      // and `echo $(cp a /etc/b)` cannot dodge the outside check while a
      // plain literal `)`/`]` stays part of the path.
      const target = targetToken(
        redirect[2],
        redirect.index + redirect[0].length,
        spanClosers,
      );
      if (target !== '' && ctx.isOutsideWorkspace(target)) {
        found.push('outside-write');
      }
    }
    // Shell-side writes by another name (issue #131): tee and trailing
    // cp/mv/install targets reach files no `>` ever touches. Both use the
    // same shared quote-stripping and last-argument target extraction,
    // scoped so the closer trim fires only on lifted tokens.
    for (const tee of command.matchAll(TEE_TARGET)) {
      const target = targetToken(
        tee[1] ?? '',
        tee.index + tee[0].length,
        spanClosers,
      );
      if (target !== '' && ctx.isOutsideWorkspace(target)) {
        found.push('outside-write');
        break;
      }
    }
    for (const copy of command.matchAll(COPY_TARGET)) {
      const target = targetToken(
        copy[2] ?? '',
        copy.index + copy[0].length,
        spanClosers,
      );
      if (target !== '' && ctx.isOutsideWorkspace(target)) {
        found.push('outside-write');
        break;
      }
    }
    // Privilege escalation and command indirection (issue #131): sudo is a
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
      if (ctx.network === 'none' && ctx.isNetworkCommand(payload)) {
        found.push('network');
      }
    }
  }
  if (
    (toolName === 'write' || toolName === 'edit') &&
    typeof args.path === 'string'
  ) {
    if (ctx.isOutsideWorkspace(args.path)) found.push('outside-write');
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
  // redacted exactly like block reasons (issue #15).
  if (toolName === 'bash' && typeof args.command === 'string') {
    return redactReason(`${capability}: ${args.command.slice(0, 120)}`);
  }
  if (typeof args.path === 'string') {
    return redactReason(`${capability}: ${toolName} ${args.path}`);
  }
  return `${capability}: ${toolName}`;
}

// File-backed store: decisions + full-access posture live beside the
// session that scoped them, so a fresh session starts safe (no file →
// default deny posture). posture.json sits beside the session for the
// audit/doctor readers coming in #57/#29. Load is corrupt-tolerant;
// saves are atomic tmp+rename (races fail safe to deny on load).
export interface AccessPosture {
  fullAccess: boolean;
  enabledAt?: number;
  enabledBy?: string;
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
      return JSON.parse(bridge.readTextFile(this.file)) as Record<
        string,
        ApprovalVerdict
      >;
    } catch {
      return {};
    }
  }

  save(decisions: Record<string, ApprovalVerdict>): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.file}.${process.pid}.tmp`;
    bridge.writeFile(tmp, JSON.stringify(decisions));
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
      return JSON.parse(bridge.readTextFile(this.postureFile)) as AccessPosture;
    } catch {
      return { fullAccess: false };
    }
  }

  savePosture(posture: AccessPosture): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.postureFile}.${process.pid}.tmp`;
    bridge.writeFile(tmp, JSON.stringify(posture));
    bridge.renameFile(tmp, this.postureFile);
  }
}

// Adapter from the service to the worker's approve hook (issue #15 slice
// C). Non-triggered calls pass immediately WITHOUT challenging — the
// worker keeps every #15 guard up for them. Triggered calls need every
// raised capability approved and return challenged=true so the worker
// stands down the guards for exactly that call. Full-access approves
// everything as challenged AND records the posture — indicated, recorded
// beside the session for audit/doctor readers (#57, #29) — never quiet.
export type ApprovalAsk = (call: {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}) => Promise<
  { approved: true; challenged: boolean } | { approved: false; reason: string }
>;

export function createApprovalAsk(
  service: ApprovalService,
  ctx: TriggerContext,
  store: FileApprovalStore,
): ApprovalAsk {
  return async (call) => {
    const capabilities = detectTriggers(call.toolName, call.args, ctx);
    if (capabilities.length === 0) return { approved: true, challenged: false };
    const posture = store.loadPosture();
    if (posture.fullAccess) {
      return { approved: true, challenged: true };
    }
    for (const capability of capabilities) {
      const verdict = await service.request({
        key: approvalKey(call.toolName, capability, call.args),
        capability,
        toolName: call.toolName,
        summary: summarizeRequest(call.toolName, capability, call.args),
      });
      if (!verdict.approved) {
        return { approved: false, reason: verdict.reason };
      }
    }
    return { approved: true, challenged: true };
  };
}

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

// The INSTALLED solo policy (issue #86; §40, §41, §59.1). This is the
// single derivation both the lane boot and `kubic doctor` read, so §40.3
// agreement between what doctor prints and what the lane enforces holds by
// construction instead of by two hand-kept copies.
//
// Deny-by-default doctrine, stated once here:
//   - classes: the explicit, documented safe default is SOLO_DEFAULTS
//     (§12.1) — filesystem workspace-write, shell true, network none,
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
//     the same classes (solo.ts withPolicyContributions) — never duplicated
//     here.
export interface SoloPolicyInput {
  workspace: string;
  /** Config-sourced classes; absent means the documented SOLO_DEFAULTS. */
  classes?: PermissionClasses;
  /**
   * Where the classes came from, as the CONFIG LAYER recorded it. Absent
   * falls back to the shape rule (classes present ⇒ 'config'), which is what
   * legacy callers mean; the composition root always passes the layer's own
   * answer, so a config-less install is never printed as 'config'.
   */
  source?: 'config' | 'default';
  /** Extension/facet contributions; telemetry composes outermost of them. */
  contributions?: ToolContribution[];
  /** Telemetry sink (issue #15 slice D); absent means no telemetry wrapper. */
  telemetry?: (record: { toolName: string; durationMs: number }) => void;
  /** Bounded approval wait (headless never answers; it denies on timeout). */
  maxPendingMs?: number;
  /** The approval route the shipped default runs on. */
  route?: 'ask-user' | 'deny';
  /** Stored decisions are scoped to one session (the shipped default). */
  sessionScoped?: boolean;
  /** Session dir carrying posture.json (session-scoped full access). */
  sessionDir?: string;
  /**
   * The answer seat (issue #96): the command's own surface for collecting a
   * verdict on a challenged call. Attached only by commands with a user
   * attached (`kubic tui`); absent means the immediate no-surface refusal
   * below, which is what every headless run keeps. An ask that resolves
   * `undefined` is a seat that could not answer — the service's own
   * maxPendingMs bound denies it rather than hanging the turn.
   */
  answer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>;
  /** Trigger sink (debug/trajectory), never consulted for the decision. */
  onTrigger?: (trigger: PolicyTrigger) => void;
  clock?: () => number;
}

// What the lane installed and what doctor must print, in ONE object.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: PermissionClasses;
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  fullAccess: boolean;
}

export interface RecordedApprovalDeny {
  capability: string;
  toolName: string;
  reason: string;
}

// The named reason a challenged call is refused with while no surface can
// collect a verdict. Named once, here, so the block reason, the doctor line
// and the headless terminus all say the same sentence.
export const NO_ANSWER_SURFACE_REASON =
  'approval required, but no approval surface is installed on this command (headless has no TTY; the TUI overlay has not landed) — refusing the operation instead of running it unapproved';

export interface InstalledSoloPolicy {
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
}

export function installedPolicyPosture(
  input: SoloPolicyInput,
): InstalledPolicyPosture {
  const classes = validateClasses({ ...(input.classes ?? {}) });
  const allowlist = toolsForClasses(classes);
  // §40.3: the derived allowlist must agree with the classes it came from —
  // a contradictory pair is refused by name here, never printed green.
  const agreement = checkAgreement(classes, allowlist);
  if (!agreement.agree) {
    throw new PolicyValidationError(
      `installed policy contradicts itself: ${agreement.reason}`,
    );
  }
  const route = input.route ?? 'ask-user';
  const sessionScoped = input.sessionScoped ?? true;
  const fullAccess =
    input.sessionDir === undefined
      ? false
      : new FileApprovalStore(input.sessionDir).loadPosture().fullAccess;
  return {
    // The layer's own answer when the caller supplies it (the composition
    // root does); the shape rule only as the legacy fallback, so the printed
    // source is never a guess about a config-less install.
    source:
      input.source ?? (input.classes === undefined ? 'default' : 'config'),
    route,
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
    sessionScoped,
    maxPendingMs: input.maxPendingMs ?? 60_000,
    fullAccess,
  };
}

export function installSoloPolicy(input: SoloPolicyInput): InstalledSoloPolicy {
  const posture = installedPolicyPosture(input);
  const denials: RecordedApprovalDeny[] = [];
  const store =
    input.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(input.sessionDir);
  const service = new ApprovalService({
    policy: validatePolicy({
      route: posture.route,
      sessionScoped: posture.sessionScoped,
      maxPendingMs: posture.maxPendingMs,
    }),
    ...(store === undefined ? {} : { store }),
    // The seat's ask is the service's awaitAnswer: the service races it
    // against its own maxPendingMs bound, so a seat that never resolves
    // denies on timeout (never hangs) exactly like the headless path.
    ...(input.answer === undefined ? {} : { awaitAnswer: input.answer }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const ask: ApprovalAsk = async (call) => {
    if (store?.loadPosture().fullAccess && posture.route === 'ask-user') {
      // Explicit, session-scoped full access — recorded, never implied.
      return { approved: true, challenged: true };
    }
    const capabilities = detectTriggers(
      call.toolName,
      call.args,
      triggerContextFor(posture.classes, input.workspace),
    );
    if (capabilities.length === 0) return { approved: true, challenged: false };
    for (const capability of capabilities) {
      const key = approvalKey(call.toolName, capability, call.args);
      // A stored decision (a real answer, from a surface that has one) wins:
      // first-answer-latched, exactly like every other approval path.
      const decided = service.decided(key);
      if (decided !== undefined) {
        if (!decided.approved) {
          denials.push({
            capability,
            toolName: call.toolName,
            reason: decided.reason,
          });
          return { approved: false, reason: decided.reason };
        }
        continue;
      }
      if (posture.route === 'deny') {
        // Configured refusal: named as the route, never as a timeout.
        const reason = `denied by policy route (capability: ${capability})`;
        denials.push({ capability, toolName: call.toolName, reason });
        return { approved: false, reason };
      }
      // An answer seat is attached (issue #96): the TUI is a command with a
      // user attached, so the verdict can be collected instead of refused.
      // The wait is bounded by maxPendingMs inside the service — a seat that
      // never answers denies on timeout rather than hanging the turn.
      if (input.answer !== undefined) {
        const verdict = await service.request({
          key,
          capability,
          toolName: call.toolName,
          summary: summarizeRequest(call.toolName, capability, call.args),
        });
        if (!verdict.approved) {
          denials.push({
            capability,
            toolName: call.toolName,
            reason: verdict.reason,
          });
          return { approved: false, reason: verdict.reason };
        }
        continue;
      }
      // NO ANSWER SURFACE IS INSTALLED — `kubic run` has no TTY, and a `kubic
      // tui` whose seat was never attached cannot collect a verdict either.
      // Waiting maxPendingMs for an answer that cannot arrive would be a
      // silent hang and a 60s stall per dangerous call; the honest default is
      // to refuse immediately and RECORD the refusal, so the composition root
      // ends the run as approval_denied (exit 4, §78 — this refusal carries no
      // timeout marker) instead of reporting a success the user never
      // approved. The refusal is deliberately NOT
      // persisted: it is a missing surface, not a user decision, and a later
      // overlay must still be able to ask about the same operation.
      const reason = `${NO_ANSWER_SURFACE_REASON} (capability: ${capability})`;
      denials.push({ capability, toolName: call.toolName, reason });
      return { approved: false, reason };
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
      ...(input.onTrigger === undefined ? {} : { onTrigger: input.onTrigger }),
    },
    contributions,
    posture,
    denials: () => [...denials],
    ask,
  };
}

// The trigger context the shipped default evaluates capabilities with: the
// same classifiers the worker guards use (issue #15), so the approval
// decision and the guard that blocks the call can never disagree.
export function triggerContextFor(
  classes: PermissionClasses,
  workspace: string,
): TriggerContext {
  return {
    workspace,
    network: classes.network,
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
  awaitAnswer?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
}

export class ApprovalService {
  private readonly policy: ApprovalPolicy;
  private readonly store: ApprovalStore;
  private readonly awaitAnswer?: (
    request: ApprovalRequest,
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
    this.decisions.set(request.key, stamped);
    this.persist();
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
    if (this.policy.autoApprove.includes(request.capability)) {
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
    if (this.policy.route === 'deny') {
      return this.submit(request, {
        approved: false,
        reason: `denied by policy route (capability: ${request.capability})`,
      });
    }
    this.pending.set(request.key, request);
    try {
      const answer = await this.waitForAnswer(request);
      if (answer === undefined) {
        // Issue #110: a timeout is an unanswered question, not a decision.
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
    const answer = this.awaitAnswer?.(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.policy.maxPendingMs);
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
