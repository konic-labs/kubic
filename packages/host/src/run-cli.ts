// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Non-interactive equivalent of the solo run: no alt-screen, no prompt,
// consumable output, exact §78 exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the solo lane in prod). This module imports the worker settlement
// kernel (pure outcome mapping) read-only — never the lane, the session
// store, or any TUI seam. Persistence (session+journal+usage+trajectory)
// flows through the injected persist hook identically for text and
// --json output.

import {
  EXIT_APPROVAL,
  EXIT_BUDGET,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
} from '../../core/src/cli/exit-codes.js';
import type { OperationErrorLike } from '../../worker/src/lane/settle.js';
import { settleTerminalStatus } from '../../worker/src/lane/settle.js';
import type { TerminalStatus } from '../../worker/src/pi-boundary.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';

export const RUN_EXIT_OK = EXIT_OK;
export const RUN_EXIT_FAILED = EXIT_FAILED;
export const RUN_EXIT_USAGE = EXIT_USAGE;
export const RUN_EXIT_BUDGET = EXIT_BUDGET;
export const RUN_EXIT_APPROVAL_DENIED = EXIT_APPROVAL;
export const RUN_EXIT_WORKSPACE_UNAVAILABLE = EXIT_WORKSPACE;
export const RUN_EXIT_PROVIDER_PROBE_FAILED = EXIT_PROVIDER;

export type RunTerminusKind =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'budget_exhausted'
  | 'approval_denied'
  | 'approval_timed_out'
  | 'workspace_unavailable'
  | 'provider_probe_failed';

export function mapTerminusToExitCode(terminus: RunTerminusKind): number {
  switch (terminus) {
    case 'completed':
      return RUN_EXIT_OK;
    case 'failed':
      return RUN_EXIT_FAILED;
    case 'usage':
      return RUN_EXIT_USAGE;
    case 'budget_exhausted':
      return RUN_EXIT_BUDGET;
    case 'approval_denied':
    case 'approval_timed_out':
      return RUN_EXIT_APPROVAL_DENIED;
    case 'workspace_unavailable':
      return RUN_EXIT_WORKSPACE_UNAVAILABLE;
    case 'provider_probe_failed':
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
  }
}

// Lane outcome → §78 terminus (issue #28, E1). Read-only consumer of the
// worker settlement kernel: completed stays 0-bound, and a
// failed/cancelled run keeps the harness error classification
// (budget/approval/workspace/provider surface as 3/4/5/6-bound termini,
// everything else as failed). No budget or approval gate is enforced in
// the headless lane yet, so budget_exhausted/approval_denied fire only
// when the lane itself yields a classified error — until then they are
// covered by the contract tests, not by live runs.
export function mapLaneOutcomeToTerminus(
  status: TerminalStatus,
  error?: OperationErrorLike,
): RunTerminusKind {
  if (status === 'completed') return 'completed';
  const kind = settleTerminalStatus(status, error).error?.kind;
  if (kind === 'budget') return 'budget_exhausted';
  if (kind === 'approval') return 'approval_denied';
  if (kind === 'workspace') return 'workspace_unavailable';
  if (kind === 'provider') return 'provider_probe_failed';
  return 'failed';
}

export interface HeadlessRunResult {
  terminus: RunTerminusKind;
  summary: string;
  sessionId: string;
  journalRef: string;
  usageRef: string;
  trajectoryRef: string;
  error?: { kind: string; message: string };
  // Issue #185 (§39, §68): the run's own usage rollup and the model that
  // answered, read back from its session after the run. Absent when no
  // session was ever created (a usage refusal before attach).
  usage?: RunUsage;
  model?: string;
  // The approval posture the lane ran under (issue #308): 'full-access'
  // when the session skips approvals. Absent when no lane was installed.
  posture?: 'approvals' | 'full-access';
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  toolCalls: number;
}

export interface RunEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: RunTerminusKind;
  result: { summary: string };
  journal: { ref: string };
  usage: { ref: string } & Partial<RunUsage>;
  trajectory: { ref: string };
  model?: string;
  // Issue #308: scripted callers detect a full-access session here.
  approvals?: { posture: 'approvals' | 'full-access' };
  error?: { kind: string; message: string };
}

export function buildRunEnvelope(
  result: HeadlessRunResult,
  exitCode: number,
): RunEnvelope {
  return {
    ok: exitCode === RUN_EXIT_OK,
    exitCode,
    sessionId: result.sessionId,
    status: result.terminus,
    result: { summary: result.summary },
    journal: { ref: result.journalRef },
    usage: { ref: result.usageRef, ...(result.usage ?? {}) },
    trajectory: { ref: result.trajectoryRef },
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.posture === undefined
      ? {}
      : { approvals: { posture: result.posture } }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export interface RunCommandDeps extends CliIo {
  run: (
    prompt: string,
    options: {
      sessionId?: string;
      timeoutMs?: number;
      maxTurns?: number;
      // §29.3 skills surface (issue #99): the parsed flags travel to the
      // runner, which owns discovery. `--no-skills` is a boolean request
      // (never a value); `--skill` is repeatable and additive.
      noSkills?: boolean;
      skills?: string[];
      // §12.1 role selection (issue #99): forwarded to the runner, which
      // loads `.kubic/roles/<name>.md` and fails closed on a refusal.
      role?: string;
      // §50 debug channel (issue #98): a boolean request is forwarded to the
      // runner, which owns the sink (stderr in prod). Never gates the run.
      debug?: boolean;
      // §41.4 (issue #308): forwarded to the runner's one enable path.
      dangerouslySkipApprovals?: boolean;
    },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
}

// Session ids are path segments under the sessions root: accept only
// [A-Za-z0-9_-] so --session can never escape into a path traversal.
// Checked here (exit 2) before any store attach is attempted.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Default wall-clock bound for a headless run (issue #84): a model that
// never stops thinking settles as budget_exhausted instead of hanging
// the process forever. Overridable per invocation with --timeout.
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

// setTimeout stores its delay in a 32-bit signed int: anything above this
// clamps to 1 ms (TimeoutOverflowWarning), so an accepted "bound" would
// fire almost immediately and misreport budget_exhausted. Parse-time
// ceiling, not a clamp: a silently shortened bound is worse than a refusal.
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

// The parsed `kubic run` invocation. commander owns the argv
// (apps/kubic/src/commands/solo.ts): flag syntax, unknown flags and
// missing values are its usage errors (exit 2); the value rules below are
// this command's own semantics, applied as commander argument parsers.
export interface RunCommandOptions {
  readonly prompt: string;
  readonly session?: string;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly role?: string;
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  readonly debug?: boolean;
  readonly json?: boolean;
  // §41.4 (issue #308): session-scoped full access for this run's session.
  readonly dangerouslySkipApprovals?: boolean;
}

// A value the command refuses (exit 2). The message is the whole reason;
// the parser layer adds which flag carried it.
export class RunArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunArgumentError';
  }
}

function positiveInt(value: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RunArgumentError('need a positive integer');
  }
  if (max !== undefined && parsed > max) {
    throw new RunArgumentError(`max ${max}`);
  }
  return parsed;
}

// `--timeout <ms>`: a positive integer no larger than setTimeout's ceiling.
export function parseRunTimeout(value: string): number {
  return positiveInt(value, MAX_RUN_TIMEOUT_MS);
}

// `--max-turns <n>`: a positive integer.
export function parseRunMaxTurns(value: string): number {
  return positiveInt(value);
}

// `--session <id>` (and every other session-id argument): a path segment
// under the sessions root, so only [A-Za-z0-9_-] — never a traversal.
export function parseSessionIdArg(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new RunArgumentError('use [A-Za-z0-9_-]');
  }
  return value;
}

// `-p/--prompt <text>`: a non-empty prompt. A separate-token value that
// starts with `--` is the flagship typo (`kubic run -p --json`) and is
// refused; a prompt that really begins with `--` is written in the
// attached form (`--prompt=--text`), which the caller detects from argv.
// A value rule, not argv parsing: commander has already bound the token to
// `-p` (a required option-argument takes the next token unconditionally),
// so this refuses a bound value that is really a mistyped flag.
const FLAG_LIKE_VALUE = /^--/;

export function checkPromptValue(value: string, attached: boolean): string {
  if (value.trim() === '') throw new RunArgumentError('the prompt is empty');
  if (!attached && FLAG_LIKE_VALUE.test(value)) {
    throw new RunArgumentError(
      `${JSON.stringify(value)} looks like a flag, not a prompt — write a prompt that starts with '--' as --prompt=${shellQuote(value)}`,
    );
  }
  return value;
}

// Store/attach/runner rejections never escape past the CLI (E2): a
// workspace-flavored failure (attach of a missing session, ENOENT/EACCES
// on the sessions root, worktree problems) maps to workspace_unavailable
// (5); everything else maps to failed (1).
function isWorkspaceFailure(error: unknown): boolean {
  const record = error as { name?: unknown; code?: unknown };
  if (record.name === 'SessionAttachError') return true;
  // A live second attachment (issue #118) is the same class of failure as a
  // missing session: the workspace cannot host this run right now — the
  // named SessionLockError message carries the holder pid.
  if (record.name === 'SessionLockError') return true;
  const haystack = [
    record.code,
    record.name,
    error instanceof Error ? error.message : error,
  ]
    .map((part) => String(part ?? ''))
    .join(' ')
    // Keywords inside a filesystem path (a checkout under
    // `.claude/worktrees/` or `~/My workspace/`) say nothing about the
    // failure's class, so paths are blanked before matching: first any
    // quoted span holding a path separator (it may contain spaces), then
    // any whitespace-delimited word holding one (absolute or relative;
    // an unquoted path with spaces splits into such words).
    .replace(/(['"`])[^'"`\n]*[\\/][^'"`\n]*\1/g, ' ')
    .replace(/[^\s]*[\\/][^\s]*/g, ' ');
  return /workspace|worktree|ENOENT|ENOTDIR|EACCES|EPERM|EROFS|ENOSPC/i.test(
    haystack,
  );
}

// Caught (non-lane) failures → §78 terminus, shared with the composition
// root so the prod path maps store/attach errors identically (E2).
export function mapCaughtErrorToTerminus(error: unknown): RunTerminusKind {
  return isWorkspaceFailure(error) ? 'workspace_unavailable' : 'failed';
}

function runFailure(
  sessionId: string | undefined,
  error: unknown,
): HeadlessRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const terminus = mapCaughtErrorToTerminus(error);
  const ref = sessionId ?? 'unassigned';
  return {
    terminus,
    summary: message,
    sessionId: ref,
    journalRef: `journal:${ref}`,
    usageRef: `usage:${ref}`,
    trajectoryRef: `trajectory:${ref}`,
    error: { kind: terminus, message },
  };
}

// POSIX single-quote escaping for suggested commands: nothing inside '…'
// expands ($, backticks, !), and an embedded ' becomes '\''.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runRunCommand(
  options: RunCommandOptions,
  deps: RunCommandDeps,
): Promise<number> {
  const log = diagnosticsOf(deps);
  // commander validated these already; re-checked because the session id
  // becomes a path segment and a direct caller skips the parser.
  if (
    options.session !== undefined &&
    !SESSION_ID_PATTERN.test(options.session)
  ) {
    log.error(
      `invalid --session id ${JSON.stringify(options.session)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  if (options.prompt.trim() === '') {
    log.error('-p needs a value (the prompt is empty)');
    return RUN_EXIT_USAGE;
  }
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  const skills = options.skills ?? [];
  let result: HeadlessRunResult;
  try {
    result = await deps.run(options.prompt, {
      sessionId: options.session,
      timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.noSkills === true ? { noSkills: true } : {}),
      ...(skills.length === 0 ? {} : { skills: [...skills] }),
      ...(options.debug === true ? { debug: true } : {}),
      ...(options.dangerouslySkipApprovals === true
        ? { dangerouslySkipApprovals: true }
        : {}),
    });
    await deps.persist?.(result);
  } catch (error) {
    result = runFailure(options.session, error);
  }
  const exitCode = mapTerminusToExitCode(result.terminus);
  if (options.json === true) {
    // One compact line, deliberately not pretty-printed: `kubic
    // orchestrate` reads a worker's envelope as the LAST stdout line.
    deps.out(JSON.stringify(buildRunEnvelope(result, exitCode)));
    return exitCode;
  }
  if (result.error !== undefined) log.error(result.error.message);
  const theme = themeOf(deps);
  const label = (name: string): string => theme.muted(`${name}:`);
  const summary =
    exitCode === RUN_EXIT_OK
      ? theme.success(result.summary)
      : theme.error(result.summary);
  deps.out(`${label('result')} ${summary}`);
  deps.out(`${label('session')} ${theme.bold(result.sessionId)}`);
  deps.out(`${label('journal')} ${result.journalRef}`);
  deps.out(`${label('usage')} ${result.usageRef}`);
  deps.out(`${label('trajectory')} ${result.trajectoryRef}`);
  return exitCode;
}
