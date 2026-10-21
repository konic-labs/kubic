// What a headless run settles into: its terminus, the exit code and failure
// class each terminus maps to, and the envelope `kubic run --json` prints.

import type {
  ClassifiedFailure,
  RetryDecision,
} from '@kubic/agent/lane/failures';
import { classifyFailure } from '@kubic/agent/lane/failures';
import type {
  LaneTerminalStatus,
  OperationErrorLike,
} from '@kubic/agent/lane/settle';
import { settleTerminalStatus } from '@kubic/agent/lane/settle';
import type { RunMode } from '@kubic/agent/permissions';
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import {
  EXIT_APPROVAL,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_TURN_LIMIT,
  EXIT_USAGE,
  EXIT_WORKSPACE,
  INTERRUPT_EXIT_CODES,
  isInterruptSignal,
} from '@kubic/core/cli/exit-codes';
import { TIMEOUT_REASON_MARKER } from '../approvals/index.js';

export type RunTerminusKind =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'turn_limit'
  // A `[policy]` spend cap stopped the run (exit 3, like the turn limit).
  | 'spend_limit'
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
    case 'spend_limit':
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
/** @internal */
export function failureForTerminus(
  terminus: RunTerminusKind,
): ClassifiedFailure | undefined {
  switch (terminus) {
    case 'turn_limit':
      return classifyFailure('limit', 'run_limit', '');
    case 'spend_limit':
      return {
        code: 'run_limit',
        remedy:
          'A [policy] spend cap stopped the run; run again once the policy allows more spend (the daily cap resets at UTC midnight). Never retry before then.',
        strategy: 'abandon',
      };
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
// root so the prod path maps store/attach errors identically.
export function mapCaughtErrorToTerminus(error: unknown): RunTerminusKind {
  return isWorkspaceFailure(error) ? 'workspace_unavailable' : 'failed';
}

// The result for a failure the run caught rather than settled (a store or
// attach error, a throw): its terminus, and the failure classification too,
// so the envelope never has to guess the domain from the exit code.
export function caughtRunResult(
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
