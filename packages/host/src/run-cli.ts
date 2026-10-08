// Headless `kubic run -p`.
// Non-interactive equivalent of the run: no alt-screen, no prompt,
// consumable output, exact exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the lane in prod). This module imports the agent settlement
// kernel (pure outcome mapping) read-only — never the lane, the session
// store, or any TUI seam. Persistence (session+journal+usage+trajectory)
// flows through the injected persist hook identically for text and
// --json output.

import {
  type ClassifiedFailure,
  classifyFailure,
  type RetryDecision,
} from '@kubic/agent/lane/failures';
import type { OperationErrorLike } from '@kubic/agent/lane/settle';
import {
  type LaneTerminalStatus,
  settleTerminalStatus,
} from '@kubic/agent/lane/settle';
import type { RunMode } from '@kubic/agent/permissions';
import {
  type CommandResult,
  EXIT_APPROVAL,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_TURN_LIMIT,
  EXIT_USAGE,
  EXIT_WORKSPACE,
  type ExitCode,
  INTERRUPT_EXIT_CODES,
  isInterruptSignal,
} from '@kubic/core/cli/exit-codes';
import { TIMEOUT_REASON_MARKER } from './approval-timeout.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';

export type RunTerminusKind =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'turn_limit'
  | 'timeout'
  | 'cancelled'
  | 'approval_denied'
  | 'approval_timed_out'
  | 'workspace_unavailable'
  | 'provider_probe_failed'
  | 'provider_transient'
  | 'provider_auth';

// The exit-code table names six codes; a run's finer terminus rides on the
// `--json` status. `timeout` is a plain task failure (1), and `turn_limit`
// (the `--max-turns` guard) has its own code (3).
export function mapTerminusToExitCode(
  terminus: RunTerminusKind,
  signal?: string,
): ExitCode {
  switch (terminus) {
    case 'completed':
      return EXIT_OK;
    case 'failed':
    case 'timeout':
      return EXIT_FAILED;
    case 'usage':
      return EXIT_USAGE;
    case 'turn_limit':
      return EXIT_TURN_LIMIT;
    // `cancelled` keeps POSIX 128+signo (SIGHUP 129, SIGINT 130, SIGTERM 143;
    // SIGINT when no signal is known) so a signalled run reads like a
    // signalled process.
    case 'cancelled':
      return signal !== undefined && isInterruptSignal(signal)
        ? INTERRUPT_EXIT_CODES[signal]
        : EXIT_CANCELLED;
    case 'approval_denied':
    case 'approval_timed_out':
      return EXIT_APPROVAL;
    case 'workspace_unavailable':
      return EXIT_WORKSPACE;
    case 'provider_probe_failed':
      return EXIT_PROVIDER;
    // A provider error during the run is a failed task, not the pre-run probe —
    // 6 is reserved for the boot probe (no provider configured, an unknown
    // stored model). The failure code is the honest half.
    case 'provider_transient':
    case 'provider_auth':
      return EXIT_FAILED;
  }
}

// Lane outcome → terminus + failure. The failure code is
// the precise half — what a retry chooser or an RL pairing reads — and the
// terminus is the class the exit code follows. A provider-classified
// lane error is `provider_auth`/`provider_transient`, never the pre-run
// probe terminus: `provider_probe_failed` is reserved for the boot probe.
export interface LaneOutcomeTerminus {
  terminus: RunTerminusKind;
  failure?: ClassifiedFailure;
}

export function mapLaneOutcomeToFailure(
  status: LaneTerminalStatus,
  error?: OperationErrorLike,
): LaneOutcomeTerminus {
  if (status === 'completed') return { terminus: 'completed' };
  const settled = settleTerminalStatus(status, error).error;
  const kind = settled?.kind ?? 'process';
  const message = settled?.message ?? '';
  // The approval terminus follows the shipped marker rule: the reason text
  // decides refusal vs elapsed wait, never a classifier keyword — an elapse
  // whose wording also says "denied" must stay `approval_timed_out`, and a
  // refusal worded "refused" must stay `approval_denied`.
  if (kind === 'approval') {
    const code = message.includes(TIMEOUT_REASON_MARKER)
      ? 'approval_timed_out'
      : 'approval_denied';
    return { terminus: code, failure: classifyFailure('approval', code, '') };
  }
  const failure = classifyFailure(kind, error?.code ?? '', message);
  switch (failure.code) {
    case 'workspace_failed':
      return { terminus: 'workspace_unavailable', failure };
    case 'provider_auth':
    case 'provider_transient':
      return { terminus: failure.code, failure };
    default:
      return { terminus: 'failed', failure };
  }
}

// Failure classification of a terminus whose code is implied: the
// guard and gate termini each have exactly one failure code, and the boot probe
// is the provider setup failure. The classification never reads the
// summary — a failure's wording must not flip a fixed code.
// `failed` reads its code from the result's own `failure`;
// `timeout`/`cancelled` have no failure code.
export function failureForTerminus(
  terminus: RunTerminusKind,
): ClassifiedFailure | undefined {
  switch (terminus) {
    case 'turn_limit':
      return classifyFailure('limit', 'run_limit', '');
    case 'approval_denied':
      return classifyFailure('approval', 'approval_denied', '');
    case 'approval_timed_out':
      return classifyFailure('approval', 'approval_timed_out', '');
    case 'workspace_unavailable':
      return classifyFailure('workspace', 'workspace_failed', '');
    case 'provider_probe_failed':
      // A probe failure is a setup failure, never transient (the same
      // decision as CODE_BY_SUBMISSION_REASON.no_model): an unknown model
      // or an unregistered stored model cannot be retried unchanged, so a
      // retry chooser must not be told to retry.
      return {
        code: 'provider_auth',
        remedy:
          'No provider/model is available, or the stored model is no longer registered; register a provider (kubic models) or pin a registered model, then rerun.',
        strategy: 'abandon',
      };
    case 'provider_transient':
      return classifyFailure('provider', 'provider_transient', '');
    case 'provider_auth':
      return classifyFailure('provider', 'provider_auth', '');
    default:
      return undefined;
  }
}

// The chooser's decision plus the executor's report —
// whether the retry happened. Retried-then-failed carries retried: true;
// decided-to-retry-but-compaction-refused and abandoned carry false.
export interface RetryRecord extends RetryDecision {
  retried: boolean;
}

export interface HeadlessRunResult {
  terminus: RunTerminusKind;
  summary: string;
  sessionId: string;
  journalRef: string;
  usageRef: string;
  trajectoryRef: string;
  error?: { kind: string; message: string };
  // The failure classification of a lane failure (code, remedy,
  // strategy) — the precise half the terminus cannot carry. Absent on
  // termini with no failure code (`timeout`, `cancelled`, `usage`).
  failure?: ClassifiedFailure;
  // The retry decision when the lane made one (overflow
  // recovery) — strategy, reason and notBefore, also on success.
  retry?: RetryRecord;
  // The interrupt that ended the run, present exactly when the
  // terminus is `cancelled`; the exit code is 128+signo from it.
  signal?: string;
  // The run's own usage rollup and the model that
  // answered, read back from its session after the run. Absent when no
  // session was ever created (a usage refusal before attach).
  usage?: RunUsage;
  model?: string;
  // The approval posture the lane ran under: 'full-access'
  // when the session skips approvals. Absent when no lane was installed.
  posture?: 'approvals' | 'full-access';
  // The run's mode: explicit `--autonomous` or off by
  // default. Absent when no session was ever created (same bound as
  // posture — the mode is read from the session record).
  mode?: RunMode;
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
  // Scripted callers detect a full-access session here.
  approvals?: { posture: 'approvals' | 'full-access' };
  // The mode the run resolved; the status already
  // names the stop condition that ended it.
  mode?: RunMode;
  error?: { kind: string; message: string };
  // The failure code, remedy and retry strategy, additive.
  failure?: ClassifiedFailure;
}

export function buildRunEnvelope(
  result: HeadlessRunResult,
  exitCode: number,
): RunEnvelope {
  // The lane path carries its own classification; every other
  // failure terminus has exactly one implied failure code.
  const failure = result.failure ?? failureForTerminus(result.terminus);
  return {
    ok: exitCode === EXIT_OK,
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
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(failure === undefined ? {} : { failure }),
  };
}

// Live progress for a `kubic run` on
// an interactive terminal. The composition root builds the sink (stderr,
// spinner, kit rendering); the runner feeds it lane facts; the command
// hands it the settled result for the receipt. Absent means today's plain
// text everywhere (pipes, files, CI, `--json`).
export interface RunProgressSink {
  /**
   * The lane booted: heading and (when `notice`) the one-line no-isolation notice.
   * `role` is the `--role` name the run selected; absent for the default role.
   */
  begin(info: {
    readonly model?: string;
    readonly notice: boolean;
    readonly role?: string;
  }): void;
  toolStart(event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }): void;
  toolEnd(event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly entry?: unknown;
  }): void;
  /** The run settled: stop the spinner and clear its line. */
  settle(): void;
  /** After the answer: the receipt line and the next steps. */
  receipt(result: HeadlessRunResult, exitCode: number): void;
}

export interface RunCommandDeps extends CliIo {
  run: (
    prompt: string,
    options: {
      sessionId?: string;
      timeoutMs?: number;
      maxTurns?: number;
      // Skills surface: the parsed flags travel to the
      // runner, which owns discovery. `--no-skills` is a boolean request
      // (never a value); `--skill` is repeatable and additive.
      noSkills?: boolean;
      skills?: string[];
      // Role selection: forwarded to the runner, which
      // loads `.kubic/roles/<name>.md` and fails closed on a refusal.
      role?: string;
      // The explicit skill to invoke — forwarded to
      // the runner, which expands it against the booted (gated-visible)
      // skills and fails the run on an unknown name.
      invokeSkill?: string;
      // Debug channel: a boolean request is forwarded to the
      // runner, which owns the sink (stderr in prod). Never gates the run.
      debug?: boolean;
      // Forwarded to the runner's one enable path.
      dangerouslySkipApprovals?: boolean;
      // Explicit autonomous mode, recorded in session
      // metadata and the audit trail, driving RunMode.
      autonomous?: boolean;
      // The per-invocation tool selection.
      tools?: readonly string[];
      noTools?: boolean;
      // Live progress on an interactive terminal.
      progress?: RunProgressSink;
    },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
  // The interactive-terminal progress sink. Present only when
  // stdout AND stderr are a coloured TTY and the run is not `--json`.
  progress?: () => RunProgressSink;
}

// Session ids are path segments under the sessions root: accept only
// [A-Za-z0-9_-] so --session can never escape into a path traversal.
// Checked here (exit 2) before any store attach is attempted.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Default wall-clock bound for a headless run: a model that
// never stops thinking settles as `timeout` instead of
// hanging the process forever. Overridable per invocation with --timeout.
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

// setTimeout stores its delay in a 32-bit signed int: anything above this
// clamps to 1 ms (TimeoutOverflowWarning), so an accepted "bound" would
// fire almost immediately and misreport a timeout. Parse-time
// ceiling, not a clamp: a silently shortened bound is worse than a refusal.
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

// The parsed `kubic run` invocation. commander owns the argv
// (apps/kubic/src/commands/session.ts): flag syntax, unknown flags and
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
  // Invoke one explicit skill first (run only).
  readonly invokeSkill?: string;
  readonly debug?: boolean;
  readonly json?: boolean;
  // Session-scoped full access for this run's session.
  readonly dangerouslySkipApprovals?: boolean;
  // Explicit autonomous mode (off by default).
  readonly autonomous?: boolean;
  // `--tools <a,b>` / `--no-tools`.
  readonly tools?: readonly string[];
  readonly noTools?: boolean;
}

// A value the command refuses (exit 2). The message is the whole reason;
// the parser layer adds which flag carried it.
class RunArgumentError extends Error {
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
  // A live second attachment is the same class of failure as a
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

// Caught (non-lane) failures → terminus, shared with the composition
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
  const failure =
    terminus === 'workspace_unavailable'
      ? classifyFailure('workspace', 'workspace_failed', message)
      : classifyFailure('process', '', message);
  const ref = sessionId ?? 'unassigned';
  return {
    terminus,
    summary: message,
    sessionId: ref,
    journalRef: `journal:${ref}`,
    usageRef: `usage:${ref}`,
    trajectoryRef: `trajectory:${ref}`,
    failure,
    error: { kind: terminus, message },
  };
}

// A refused config stops the run before any lane exists: the
// documented exit-1 failure, shaped as the standard run envelope so a
// `--json` consumer still parses exactly one document (compact, the same
// line shape every run envelope has).
export function refusedRunResult(message: string): HeadlessRunResult {
  return {
    terminus: 'failed',
    summary: message,
    sessionId: 'unassigned',
    journalRef: 'journal:unassigned',
    usageRef: 'usage:unassigned',
    trajectoryRef: 'trajectory:unassigned',
    error: { kind: 'failed', message },
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
): Promise<CommandResult> {
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
    return { exitCode: EXIT_USAGE };
  }
  if (options.prompt.trim() === '') {
    log.error('-p needs a value (the prompt is empty)');
    return { exitCode: EXIT_USAGE };
  }
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  const skills = options.skills ?? [];
  const progress = options.json === true ? undefined : deps.progress?.();
  let result: HeadlessRunResult;
  try {
    result = await deps.run(options.prompt, {
      sessionId: options.session,
      timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns,
      ...(options.role === undefined ? {} : { role: options.role }),
      // The explicit skill invocation travels with
      // the run into the headless lane.
      ...(options.invokeSkill === undefined
        ? {}
        : { invokeSkill: options.invokeSkill }),
      ...(options.noSkills === true ? { noSkills: true } : {}),
      ...(skills.length === 0 ? {} : { skills: [...skills] }),
      ...(options.debug === true ? { debug: true } : {}),
      ...(options.dangerouslySkipApprovals === true
        ? { dangerouslySkipApprovals: true }
        : {}),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : { tools: [...options.tools] }),
      ...(options.noTools === true ? { noTools: true } : {}),
      ...(progress === undefined ? {} : { progress }),
    });
    await deps.persist?.(result);
  } catch (error) {
    result = runFailure(options.session, error);
  }
  const exitCode = mapTerminusToExitCode(result.terminus, result.signal);
  if (options.json === true) {
    // One compact line, deliberately not pretty-printed: a script reads the
    // envelope as the LAST stdout line.
    deps.out(JSON.stringify(buildRunEnvelope(result, exitCode)));
    return { exitCode };
  }
  if (progress !== undefined) {
    // The interactive rendering. The answer is the command's
    // data (stdout); the receipt and next steps are presentation (stderr,
    // through the sink). The plain lines below stay for every other case.
    progress.settle();
    if (exitCode === EXIT_OK) {
      deps.out('');
      deps.out(result.summary);
      deps.out('');
    } else if (result.error !== undefined) {
      log.error(result.error.message);
    }
    progress.receipt(result, exitCode);
    return { exitCode };
  }
  if (result.error !== undefined) log.error(result.error.message);
  const theme = themeOf(deps);
  const label = (name: string): string => theme.muted(`${name}:`);
  const summary =
    exitCode === EXIT_OK
      ? theme.success(result.summary)
      : theme.error(result.summary);
  deps.out(`${label('result')} ${summary}`);
  deps.out(`${label('session')} ${theme.bold(result.sessionId)}`);
  deps.out(`${label('journal')} ${result.journalRef}`);
  deps.out(`${label('usage')} ${result.usageRef}`);
  deps.out(`${label('trajectory')} ${result.trajectoryRef}`);
  return { exitCode };
}
