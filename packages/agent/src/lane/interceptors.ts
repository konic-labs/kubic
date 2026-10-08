// Policy interceptors on the lane.
// Registered as ordered pi-durable `ToolTask.beforeTool` hooks,
// so chaining, first-block-wins, and throw-becomes-block are the harness's
// real semantics, not ours. Every handler is fail-closed: a policy exception
// blocks with its redacted message. `beforeTool` runs before the tool's
// intent is committed, so a crash while a handler awaits (the approval seat)
// re-runs the hook on resume instead of resuming an unapproved execution.
//
// Enforcement map (what each class means at this layer):
//   filesystem — tool allowlist + path confine below. Symlinks
//     are NOT resolved (lexical confine only, same limit as the exec seam);
//     a workspace symlink pointing outside is a known escape, documented
//     here instead of silently "handled".
//   shell true — bash present, destructive commands blocked.
//   shell read-only-allowlist — bash present, destructive AND network
//     commands blocked, and every `|`/`&&`/`;`/`&`/newline segment must pass
//     the explicit read-only verb allowlist: redirection,
//     in-place edits, find write actions, write/exec flags, git options that
//     execute code, shell expansion, process substitution and any
//     non-allowlisted verb are refused by name.
//   shell false — bash absent via allowlist.
//   network none (and a domain-less allowlist, enforced as none) —
//   network-command verbs blocked in bash. full
//     change nothing at the tool layer (documented, not silent): there is
//     no network tool to remove, and shell:true can still curl. The flag
//     is consumed by approval triggers.
//   git/credentials — NO tool-layer enforcement today (no git/credential tools
//   exist yet; git arrives with). The flags are stored
//     validated config consumed by approval triggers, never
//     silently dropped.
// The destructive matcher is a literal-pattern heuristic, not a sandbox:
// it sees the command string only, so $CMD indirection, backslash escapes,
// and eval-obfuscation bypass THIS guard (stated, not silent). Since issue
// The trigger layer raises on the cheap shapes this guard misses — a
// destructive/network verb inside $(…)/backticks/eval and `sudo` anywhere
// become approval asks instead of slipping through silently — but the
// detection is still literal-pattern: python/node/npm exfiltration, quoted
// or backslash-obfuscated verbs, and whitespace tricks around redirect
// targets stay unenforceable, documented as such in host/approvals.ts.
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { redactSecretShapes } from '../../../core/src/secret-shapes.js';
import { readRootFor } from '../../../exec/src/read-roots.js';
import {
  effectiveNetworkLevel,
  type NetworkLevel,
  type ShellLevel,
} from '../permissions.js';
import type { HookRegistration, JsonValue } from '../pi-boundary.js';
import { hook, ToolTask } from '../pi-boundary.js';

export interface PolicyInterceptorOptions {
  workspace: string;
  shell?: ShellLevel;
  network?: NetworkLevel;
  // Read-only confinement exception: the directories
  // (or files) of the skills advertised with absolute paths outside the
  // workspace. Only the `read` tool may open a path inside one; write,
  // edit, ls, find and grep keep re-rooting every outside path.
  readRoots?: readonly string[];
  isDestructive?: (command: string, workspace: string) => boolean;
  // Approval decider. Consulted for every
  // call first: denials block; approvals let the call
  // through. Only challenged approvals (a real capability was raised and
  // granted) stand down the destructive/network/confine guards for that
  // exact toolCallId — an unchallenged fast-path keeps every guard up.
  // The type lives here (not in host) because the worker cannot import
  // host; the host adapts its ApprovalService to it.
  approve?: (call: ApprovalCall) => Promise<ApprovalAskVerdict>;
}

export interface ApprovalCall {
  toolName: string;
  // The harness-validated arguments, untyped at this seam: the host's
  // detectors own the per-capability shape (same contract as before Pi 1.0).
  args: Record<string, unknown>;
  // The durable call id, which is the provider's toolCallId: the seat's
  // stand-down set is keyed on exactly this value.
  toolCallId: string;
}

export type ApprovalAskVerdict =
  | {
      approved: true;
      challenged: boolean;
      // The operator edited the call before allowing it — these
      // arguments replace the call's (and were judged themselves).
      arguments?: Record<string, unknown>;
    }
  | { approved: false; reason: string };

const SENSITIVE_PATH = /(\.ssh\/|\.gnupg?\/|\/etc\/|passwd$|\.key$|\.pem$)/i;

function rmBlocked(command: string, workspace: string): boolean {
  const segments = command.split(/(?:^|[|;&])\s*(?=(?:rm|rmdir)\b)/i);
  for (const segment of segments) {
    const match = /^\s*(rm|rmdir)\b([^|;&]*)/i.exec(segment);
    if (match === null) continue;
    const flags = match[2] ?? '';
    if (/-[a-zA-Z]*[rf]/i.test(flags)) return true;
    // Every target token is inspected — checking only the first lets
    // `rm notes.txt /etc/passwd` through.
    const tokens = flags
      .replace(/-[a-zA-Z]+\s*/g, ' ')
      .replace(/--\S+\s*/g, ' ')
      .split(/\s+/)
      .filter((token) => token !== '');
    for (const target of tokens) {
      const resolved = isAbsolute(target)
        ? resolve(target)
        : resolve(workspace, target);
      const root = resolve(workspace);
      if (resolved !== root && !resolved.startsWith(`${root}/`)) return true;
      if (SENSITIVE_PATH.test(target)) return true;
    }
  }
  return false;
}

// Patterns that read the whole command: none of them is a `[^|;&]*` gap.
const WHOLE_COMMAND_PATTERNS = [
  /\bmkfs\b/i,
  /\bshred\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

// Every other destructive shape is a HEAD verb followed, later in the SAME
// command segment (no `|`, `;` or `&` between), by a chain of further
// tokens: `dd … of=/dev/`, `git clean … -f`, `chmod|chown … -R`, `find …
// -delete`, `git … push … --force|-f|+refspec`, `git … reset …
// --hard`, `git … checkout … (-- | . | -f | --force)` and `git … restore …
// (--worktree | -W)`. A regex per shape with `[^|;&]*` gaps would backtrack
// polynomially: `git push ` repeated 2000 times took 13 s and `git restore
// --staged ` repeated 2000 times 50 s, before every bash call.
//
// A chain is walked leftmost-first inside one segment — each step searches
// from the end of the previous one. That is exactly as strong as the gapped
// regex: the gap absorbs anything, so if any occurrence of a step leads to a
// full match then the LEFTMOST one does too (it leaves the most text for the
// steps after it). The walk is linear per segment. The segment handed in
// keeps its trailing separator character, because `+\S` may consume it, and
// `$` inside it is the end of the command only for the last segment.
const SEGMENT_CHAINS: ReadonlyArray<readonly RegExp[]> = [
  [/\bdd\b/gi, /\bof=\s*\/dev\//gi],
  [/\bgit\s+clean\s+/gi, /-[a-zA-Z]*f/gi],
  [/\b(chmod|chown)\b/gi, /\s-[a-zA-Z]*R/gi],
  [/\bfind\b/gi, /\s-delete\b/gi],
  [
    /\bgit\b/gi,
    /\spush\b/gi,
    /\s(--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)/gi,
  ],
  [/\bgit\b/gi, /\sreset\b/gi, /\s--hard\b/gi],
  [/\bgit\b/gi, /\scheckout\b/gi, /\s(--(\s|$)|\.(\s|$)|-f\b|--force\b)/gi],
  [/\bgit\b/gi, /\srestore\b/gi, /\s(--worktree|-W)\b/gi],
];
const GIT_HEAD = /\bgit\b/gi;
const RESTORE_VERB = /\srestore\b/gi;
const STAGED_ONLY = /\s(--staged|-S)\b/gi;
const SEGMENT_HEAD = /\b(git|dd|chmod|chown|find)\b/i;
const SEGMENT_SEPARATOR = /[|;&]/g;

function chainMatches(segment: string, chain: readonly RegExp[]): boolean {
  let at = 0;
  for (const step of chain) {
    step.lastIndex = at;
    const hit = step.exec(segment);
    if (hit === null) return false;
    at = hit.index + hit[0].length;
  }
  return true;
}

// `git … restore` discards the working tree unless it is a staged-only
// restore: a restore with no `--staged`/`-S` after it. The absence is
// monotone — if some `restore` has none after it, the LAST one has none — so
// only the last `restore` needs its tail checked.
function unstagedRestore(segment: string): boolean {
  GIT_HEAD.lastIndex = 0;
  const git = GIT_HEAD.exec(segment);
  if (git === null) return false;
  RESTORE_VERB.lastIndex = git.index + git[0].length;
  let lastEnd = -1;
  for (
    let hit = RESTORE_VERB.exec(segment);
    hit !== null;
    hit = RESTORE_VERB.exec(segment)
  ) {
    lastEnd = hit.index + hit[0].length;
  }
  if (lastEnd < 0) return false;
  STAGED_ONLY.lastIndex = lastEnd;
  return STAGED_ONLY.exec(segment) === null;
}

function segmentDestructive(segment: string): boolean {
  if (!SEGMENT_HEAD.test(segment)) return false;
  return (
    SEGMENT_CHAINS.some((chain) => chainMatches(segment, chain)) ||
    unstagedRestore(segment)
  );
}

function anySegmentDestructive(command: string): boolean {
  let from = 0;
  for (;;) {
    SEGMENT_SEPARATOR.lastIndex = from;
    const separator = SEGMENT_SEPARATOR.exec(command);
    const end = separator === null ? command.length : separator.index + 1;
    if (segmentDestructive(command.slice(from, end))) return true;
    if (separator === null) return false;
    from = end;
  }
}

export function defaultIsDestructive(
  command: string,
  workspace = '/work',
): boolean {
  if (rmBlocked(command, workspace)) return true;
  return (
    WHOLE_COMMAND_PATTERNS.some((pattern) => pattern.test(command)) ||
    anySegmentDestructive(command)
  );
}

const NETWORK_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsftp\b/i,
  /\bftp\b/i,
  /\btelnet\b/i,
  /\bnc\b/i,
];

// Literal-pattern heuristic with the same stated scope as the destructive
// matcher: python/node/npm/pip/git/openssl exfiltration bypasses
// network:none today. The verbs above cover the interactive-transfer
// layer; everything else is approvals' problem.

export function isNetworkCommand(command: string): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(command));
}

// --- read-only shell allowlist -------------------
//
// `shell: 'read-only-allowlist'` is an explicit, closed allowlist, not "full
// shell minus network": a read-only role must not write files or git state
// through bash. Every pipeline/`&&`/`;`
// segment must head with a read-only verb, redirection is refused, and the
// verbs that can write as a side effect (git, find, sed/perl) are checked
// for their write forms. Anything else is blocked with a named reason —
// never silently allowed. The parser is lexical (quotes are stripped, not
// interpreted), so it errs toward blocking, like every guard here.

// The verbs a read-only role may run. Deliberately a closed set: adding a
// verb is a product decision, not a fallthrough.
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'git',
]);

// The git subcommands that only read — the same set derives the git read
// tools from.
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
]);

// git global options that take a separate argument, so the option's value is
// not mistaken for the subcommand. Options that can execute code are NOT
// here: they are refused before this set is consulted.
const GIT_OPTION_ARGUMENTS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--attr-source',
]);

// git global options that can execute arbitrary code: `-c`/`--config-env` set
// any config git then honours (`core.pager`, `diff.external`, `alias.*`), and
// `--exec-path`/`--upload-pack`/ `--receive-pack` name a binary git runs. A
// read-only role never needs them, so they are refused by name — over-blocking
// is the correct direction here.
const GIT_EXECUTING_OPTION =
  /^(?:-c|--(?:config-env|exec-path|upload-pack|receive-pack)(?:=|$))/;

// find actions that write or run another command.
const FIND_WRITE_ACTION =
  /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

// sed/perl in-place editing: `-i`, `-i.bak`, a combined cluster (`-ni`,
// `-pi`), or the long form.
const IN_PLACE_FLAG = /^-[A-Za-z]*i/;

// Flags that write or execute under an otherwise read-only verb: `git diff
// --output=<file>` writes, `rg --pre=<command>` runs a command per file, `rg
// --hostname-bin` runs one per hostname lookup.
const WRITE_FLAG = /^--(?:output|pre|hostname-bin)(?:=|$)/;

// `|`, `||`, `&&`, `;`, a single `&` and a newline all start a new command:
// checking only the first verb of `ls & git commit -m x` left everything
// after the `&` unchecked. `&&` matches first, so it stays
// one separator, and `&>`/`&>>` land in a segment whose `>` scan blocks them.
const SEGMENT_SPLIT = /\|\||&&|[|;&\n]/;
// Both quote forms, for the redirect and verb scans: a quoted `>` is an
// argument, and a quoted command name is still that command.
const QUOTED_SPAN = /'[^']*'|"[^"]*"/g;
// Only single quotes are literal to the shell, so only they may be stripped
// before the expansion scan: `"$R"` still expands.
const SINGLE_QUOTED_SPAN = /'[^']*'/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function gitReadOnlyViolation(tokens: readonly string[]): string | undefined {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '--') break;
    if (token.startsWith('-')) {
      if (GIT_EXECUTING_OPTION.test(token)) {
        return `git ${token} can execute code`;
      }
      i += GIT_OPTION_ARGUMENTS.has(token) ? 2 : 1;
      continue;
    }
    return READ_ONLY_GIT_SUBCOMMANDS.has(token)
      ? undefined
      : `git '${token}' is not read-only`;
  }
  return 'git without a read-only subcommand';
}

function readOnlySegmentViolation(segment: string): string | undefined {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  let i = 0;
  // Leading `VAR=value` assignments are not the command; a command
  // substitution inside one is another command and is refused.
  while (i < tokens.length && ASSIGNMENT.test(tokens[i] ?? '')) {
    const value = (tokens[i] ?? '').split('=').slice(1).join('=');
    if (value.includes('$(') || value.includes('`')) {
      return 'a command substitution is not read-only';
    }
    i += 1;
  }
  const verb = tokens[i];
  if (verb === undefined) return undefined;
  const rest = tokens.slice(i + 1);
  const writeFlag = rest.find((token) => WRITE_FLAG.test(token));
  if (writeFlag !== undefined) {
    return `${verb} ${writeFlag} writes or executes`;
  }
  if (verb === 'git') return gitReadOnlyViolation(rest);
  if (verb === 'find') {
    const action = rest.find((token) => FIND_WRITE_ACTION.test(token));
    if (action !== undefined) return `find ${action} is not read-only`;
  }
  if (verb === 'sed' || verb === 'perl') {
    const inPlace = rest.find(
      (token) =>
        token === '--in-place' ||
        token.startsWith('--in-place=') ||
        IN_PLACE_FLAG.test(token),
    );
    if (inPlace !== undefined) return `${verb} -i edits in place`;
  }
  if (!READ_ONLY_VERBS.has(verb)) {
    return `'${verb}' is not on the read-only allowlist`;
  }
  return undefined;
}

// The reason a command is not read-only, or undefined when every segment
// passes. Exported so the level's contract is unit-testable without a lane.
export function readOnlyViolation(command: string): string | undefined {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    // Quotes are stripped, not interpreted: a quoted `>` is an argument, a
    // quoted command name is still that command (and is refused).
    const bare = segment.replace(QUOTED_SPAN, ' ');
    if (bare.includes('>')) return 'redirection is not read-only';
    // Expansion is never interpreted, so it can launder another command
    // (`cat $(git commit -m x)`) or a redirect (`R='> out'; cat a $R`): a
    // substitution or any unquoted `$` is refused, fail-closed, like the
    // outside-write detector's expanded targets. Single-quoted text is
    // literal and stripped first; double quotes are not.
    const unquoted = segment.replace(SINGLE_QUOTED_SPAN, ' ');
    if (unquoted.includes('$(') || unquoted.includes('`')) {
      return 'a command substitution is not read-only';
    }
    // Process substitution runs a command too (`<(…)`; the output form
    // `>(…)` is already caught by the redirect scan above).
    if (unquoted.includes('<(')) {
      return 'a process substitution is not read-only';
    }
    if (unquoted.includes('$')) {
      return 'a shell-expanded value is not read-only';
    }
    const violation = readOnlySegmentViolation(bare);
    if (violation !== undefined) return violation;
  }
  return undefined;
}

export function confinePath(
  workspace: string,
  path: string,
): { confined: string; rewritten: boolean } {
  const root = resolve(workspace);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (resolved === root || resolved.startsWith(`${root}/`))
    return { confined: resolved, rewritten: false };
  // Re-root under the workspace. The rewritten path is operator-visible in
  // the tool call, so a same-named workspace file can confuse but never
  // silently serve an outside file.
  const tail = resolved
    .split('/')
    .filter((part) => part !== '' && part !== '..' && part !== '.');
  return { confined: join(root, tail.join('/')), rewritten: true };
}

// Reasons persist into the trajectory, so commands and raw errors are
// truncated and secret-shaped values redacted before they become blocks.
export function redactReason(value: string): string {
  const short = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return redactSecrets(short);
}

// Approval summaries, block reasons, the trajectory and the audit ledger all
// pass through this redactor, so it composes the shared @kubic/core shape
// table on top of the inline rules. It is deliberately at least as strong as
// the host's display redactor (approval-display.ts): the display one keeps
// prose readable because the operator must see what will run, this one may
// over-redact because what it writes is persisted.
const REDACTED = '[REDACTED]';

// A credential-shaped word: 10+ token characters, the same threshold the
// shared table's bearer rule uses, so a scheme word before prose (`bearer of
// bad news`) stays readable while a short token still hits the keyword pass.
const CREDENTIAL_WORD = '[A-Za-z0-9][A-Za-z0-9\\-._~+=]{9,}';

// The FULL credential after an authorization scheme. The scheme
// word is kept so the reader sees what was hidden; `Authorization: Bearer
// sk-live-123` redacts the whole credential, not only `Bearer`.
const AUTH_CREDENTIAL = new RegExp(
  [
    // Header form: `Authorization[:=] [scheme] <credential>` — the separator
    // and the scheme are both optional, so the space-separated
    // `Authorization hunter2` and `--authorization hunter2` forms are covered
    // too (review of: dropping `authorization` from the keyword pass had
    // left the no-colon spelling in the clear).
    String.raw`(\bauthorization\s*[:=]?\s*(?:(?:bearer|basic|token|digest)\s+)?)\S+`,
    // Bare scheme form: `Bearer <credential>` / `Basic <credential>`.
    `((?:^|[\\s"'=(])(?:bearer|basic|token|digest)\\s+)(${CREDENTIAL_WORD})`,
  ].join('|'),
  'gi',
);

// URL userinfo that carries a password (`https://user:pw@host`). User-only
// userinfo (`ssh://git@host`) is not a secret and stays readable. The scheme
// length is BOUNDED: an unbounded `[a-z0-9+.-]*` before the required `://`
// backtracks over a long letter-run at every start position (quadratic), and
// no real scheme is 20 characters long.
const URL_USERINFO = /([a-z][a-z0-9+.-]{1,20}:\/\/)[^/\s@:]+:[^/\s@]+@/gi;

// A user flag whose operand has the `user:password` shape: curl's `-u` /
// `--user` and its proxy twin `-U` / `--proxy-user`. The short forms may be
// attached (`-uadmin:hunter2`, review of); the long forms need `=` or a
// space. The colon is required, so an unrelated `-u` (`cp -u a b`,
// `sort -u names`) is left alone.
const USER_FLAG_CREDENTIAL =
  /((?:^|[\s"'])(?:-u|-U)(?:[=\s]\s*)?|(?:^|[\s"'])(?:--user|--proxy-user)[=\s]\s*"?)[^\s"']*:[^\s"']*/gi;

// Secret-named values: `--token abc`, `SECRET_KEY=x`, `password: y`, and a
// short bare `bearer abc` (the authorization header and the long bare
// schemes are handled above).
const KEYWORD_SECRET =
  /((?:token|password|passwd|secret|api[-_]?key|bearer|private[-_]?key)\s*(?:[=:]\s*|\s+))\S+/gi;

// The redaction half alone, never truncating: an approval
// dialog must show the whole command, so it redacts without cutting.
export function redactSecrets(value: string): string {
  return redactSecretShapes(
    value
      .replace(AUTH_CREDENTIAL, '$1$2[REDACTED]')
      .replace(URL_USERINFO, `$1${REDACTED}@`)
      .replace(USER_FLAG_CREDENTIAL, `$1${REDACTED}`)
      .replace(KEYWORD_SECRET, `$1${REDACTED}`),
  );
}

// A pi-durable block verdict: the harness turns the string into the error
// result the model sees (`Tool call blocked: …`).
function block(reason: string): { block: string } {
  return { block: redactReason(reason) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failClosed<T>(
  fn: () => T | Promise<T>,
): Promise<T | { block: string }> {
  try {
    const value = fn();
    return value instanceof Promise
      ? value.catch((error: unknown) => block(errorText(error)))
      : Promise.resolve(value);
  } catch (error: unknown) {
    return Promise.resolve(block(errorText(error)));
  }
}

// The canonical form of a call's arguments for the stand-down key: JSON key
// order is not stable across providers, so every object is sorted before
// hashing, and the hash keeps the map small whatever a tool's arguments carry
// (a write's content can be megabytes).
function canonicalArgsHash(args: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(sort(args)))
    .digest('hex')
    .slice(0, 16);
}

// Tools whose path-like args are confined. read/write/edit/ls take `path`,
// find/grep take `root`.
const CONFINED_TOOLS: Record<string, string[]> = {
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  ls: ['path'],
  find: ['root'],
  grep: ['root'],
};

// Rewrites the confined path/root arguments of a call. The input is Pi's
// `JsonObject` (the harness hands the hook its own `ToolCall`), read here
// through the plain `Record<string, unknown>` every argument bag satisfies;
// every rewrite replaces one string with another, so the shape is preserved.
function confineArgs(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> | undefined {
  const keys = CONFINED_TOOLS[toolName];
  if (keys === undefined) return undefined;
  let rewritten = false;
  const next = { ...args };
  for (const key of keys) {
    const value = next[key];
    if (typeof value !== 'string') continue;
    const { confined, rewritten: hit } = confinePath(workspace, value);
    if (hit) {
      next[key] = confined;
      rewritten = true;
    }
  }
  return rewritten ? next : undefined;
}

// The lane's policy interception as ordered `ToolTask` hooks.
// Order is correctness: the approval seat first, then the
// destructive/network guard, then the confine rewrite last — and the
// harness skips every later hook once a block is returned. Each
// registration is one handler, so the order of this array IS the chain
// order.
//
// State lifetime: the approved call ids live in THIS invocation's closure — call the factory once per
// lane boot (boot.ts builds its `kubic.policy` extension fresh on every
// boot). Installing one returned array into two boots would share them, so
// the factory deliberately never keeps state across calls: two invocations,
// even with the same options object, start clean.
export function policyInterceptorHooks(
  options: PolicyInterceptorOptions,
): HookRegistration[] {
  const isDestructive = options.isDestructive ?? defaultIsDestructive;
  const readRoots = (options.readRoots ?? []).map((root) => resolve(root));
  // Tool calls a real challenge cleared, keyed by the call id AND the exact
  // arguments it was cleared for. The id alone is not an
  // identity: it comes from the provider (an OpenAI-compatible server can
  // repeat `call_0` or send `""`), so an approved `rm -rf x` must not stand
  // the guards down for a later, different call that reuses the id. Each
  // entry is SPENT when that call's beforeTool chain finishes, so a repeated
  // call asks again instead of inheriting the stand-down. Capped FIFO over
  // call ids: a call whose chain never finished (a thrown guard) is evicted
  // eventually, and an entry can only ever stand down the exact id+args pair
  // it was granted for. Deliberately in-memory: a resumed process re-asks,
  // never inherits a stand-down it did not grant.
  const approvedCalls = new Map<string, Set<string>>();
  const APPROVED_CALLS_CAP = 512;
  const markApproved = (
    callId: string,
    args: Record<string, unknown>,
  ): void => {
    // An empty id is never a stand-down key (defence in depth: the harness
    // always assigns one, but a broken provider must not win).
    if (callId === '') return;
    const keys = approvedCalls.get(callId) ?? new Set<string>();
    keys.add(canonicalArgsHash(args));
    // Re-insert so the FIFO evicts the least recently marked call id.
    approvedCalls.delete(callId);
    approvedCalls.set(callId, keys);
    while (approvedCalls.size > APPROVED_CALLS_CAP) {
      const oldest = approvedCalls.keys().next();
      if (oldest.done) break;
      approvedCalls.delete(oldest.value);
    }
  };
  const isApproved = (
    callId: string,
    args: Record<string, unknown>,
  ): boolean => {
    // No hash for the common case: a call id with no entry is the fast path.
    const keys = callId === '' ? undefined : approvedCalls.get(callId);
    return keys !== undefined && keys.has(canonicalArgsHash(args));
  };
  // Every entry of one call id. Deletion is by id, not by the args hash:
  // the confine guard rewrites `call.arguments`, so the arguments a later
  // hook receives are not the ones the stand-down was stored for.
  const consumeApproved = (callId: string): void => {
    approvedCalls.delete(callId);
  };
  // The shell calls the operator rewrote, by call id — the
  // result says what ran, so neither the model nor the transcript takes the
  // proposed command's output for its own. Capped like the stand-downs.
  const editedCalls = new Map<string, { from: string; to: string }>();
  const registrations: HookRegistration[] = [];

  registrations.push(
    hook(ToolTask, {
      // The ask is awaited here, BEFORE the harness commits the tool's
      // intent: a crash while the user decides re-asks on resume instead of
      // resuming an unapproved execution.
      beforeTool: (call) =>
        failClosed(async () => {
          if (options.approve === undefined) return undefined;
          const verdict = await options.approve({
            toolName: call.name,
            args: call.arguments,
            toolCallId: call.id,
          });
          if (verdict.approved) {
            // An edited call runs as edited — the later guards see
            // (and a stand-down covers) exactly the arguments that were judged.
            const args = verdict.arguments ?? call.arguments;
            if (verdict.challenged) markApproved(call.id, args);
            if (
              verdict.arguments !== undefined &&
              call.name === 'bash' &&
              call.id !== ''
            ) {
              editedCalls.set(call.id, {
                from: String(call.arguments.command ?? ''),
                to: String(verdict.arguments.command ?? ''),
              });
              while (editedCalls.size > APPROVED_CALLS_CAP) {
                const oldest = editedCalls.keys().next();
                if (oldest.done) break;
                editedCalls.delete(oldest.value);
              }
            }
            return verdict.arguments === undefined
              ? undefined
              : { arguments: verdict.arguments as Record<string, JsonValue> };
          }
          return block(`not approved: ${verdict.reason}`);
        }),
      // An edited call's result opens with what actually ran.
      afterTool: (call, result) => {
        const edit = editedCalls.get(call.id);
        if (edit === undefined) return undefined;
        editedCalls.delete(call.id);
        if (result.content === undefined) return undefined;
        return {
          ...result,
          content: [
            {
              type: 'text',
              text: `[edited by the user — ran: ${redactSecrets(edit.to)} (proposed: ${redactSecrets(edit.from)})]\n`,
            },
            ...result.content,
          ],
        };
      },
    }),
  );

  registrations.push(
    hook(ToolTask, {
      beforeTool: (call) =>
        failClosed(() => {
          if (isApproved(call.id, call.arguments)) return undefined;
          if (call.name !== 'bash') return undefined;
          const command =
            typeof call.arguments.command === 'string'
              ? call.arguments.command
              : '';
          if (isDestructive(command, options.workspace)) {
            return block(`destructive command blocked: ${command}`);
          }
          // A domain-less `allowlist` allows nothing: it is
          // enforced as `none`, never as the unrestricted `full`.
          const network =
            options.network === undefined
              ? undefined
              : effectiveNetworkLevel(options.network);
          if (
            (network === 'none' || options.shell === 'read-only-allowlist') &&
            isNetworkCommand(command)
          ) {
            const declared = options.network ?? 'none';
            return block(
              `network command blocked (network: ${declared}${declared === 'none' ? '' : ', enforced as none'}): ${command}`,
            );
          }
          // A read-only role gets the explicit allowlist,
          // not the full shell minus network.
          if (options.shell === 'read-only-allowlist') {
            const violation = readOnlyViolation(command);
            if (violation !== undefined) {
              return block(`read-only shell blocked: ${violation}: ${command}`);
            }
          }
          return undefined;
        }),
    }),
  );

  registrations.push(
    hook(ToolTask, {
      beforeTool: (call) =>
        failClosed(() => {
          if (isApproved(call.id, call.arguments)) return undefined;
          if (
            call.name === 'read' &&
            typeof call.arguments.path === 'string' &&
            readRootFor(readRoots, call.arguments.path) !== undefined
          ) {
            return undefined;
          }
          const confined = confineArgs(
            call.name,
            call.arguments,
            options.workspace,
          );
          if (confined === undefined) return undefined;
          // Pi's `JsonObject` (the hook's input) and the harness's own
          // document `JsonObject` (the hook's result) are one JSON value
          // under two copies of the alias; the rewrite replaced only
          // strings, and the harness re-validates it against the schema.
          return { arguments: confined as Record<string, JsonValue> };
        }),
    }),
  );

  registrations.push(
    hook(ToolTask, {
      // Last in the chain: a stand-down is SPENT once the call
      // it was granted for has run its guards. Registered after every guard
      // so all of them saw it, and deleting by call id because the confine
      // guard may have rewritten the arguments a later hook receives.
      beforeTool: (call) =>
        failClosed(() => {
          consumeApproved(call.id);
          return undefined;
        }),
    }),
  );

  return registrations;
}
