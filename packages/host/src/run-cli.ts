// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Non-interactive equivalent of the solo run: no alt-screen, no prompt,
// consumable output, exact §78 exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the solo lane in prod). This module imports the worker settlement
// kernel (pure outcome mapping) read-only — never the lane, the session
// store, or any TUI seam. Persistence (session+journal+usage+trajectory)
// flows through the injected persist hook identically for text and
// --json output.

import type { OperationErrorLike } from '../../worker/src/lane/settle.js';
import { settleTerminalStatus } from '../../worker/src/lane/settle.js';
import type { TerminalStatus } from '../../worker/src/pi-boundary.js';

export const RUN_EXIT_OK = 0;
export const RUN_EXIT_FAILED = 1;
export const RUN_EXIT_USAGE = 2;
export const RUN_EXIT_BUDGET = 3;
export const RUN_EXIT_APPROVAL_DENIED = 4;
export const RUN_EXIT_WORKSPACE_UNAVAILABLE = 5;
export const RUN_EXIT_PROVIDER_PROBE_FAILED = 6;

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
}

export interface RunEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: RunTerminusKind;
  result: { summary: string };
  journal: { ref: string };
  usage: { ref: string };
  trajectory: { ref: string };
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
    usage: { ref: result.usageRef },
    trajectory: { ref: result.trajectoryRef },
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export interface RunCommandDeps {
  out: (line: string) => void;
  run: (
    prompt: string,
    options: { sessionId?: string },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
}

// Session ids are path segments under the sessions root: accept only
// [A-Za-z0-9_-] so --session can never escape into a path traversal.
// Checked here (exit 2) before any store attach is attempted.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function usage(out: (line: string) => void): number {
  out('usage: kubic run -p <prompt> [--session <id>] [--json]');
  return RUN_EXIT_USAGE;
}

// Store/attach/runner rejections never escape past the CLI (E2): a
// workspace-flavored failure (attach of a missing session, ENOENT/EACCES
// on the sessions root, worktree problems) maps to workspace_unavailable
// (5); everything else maps to failed (1).
function isWorkspaceFailure(error: unknown): boolean {
  const record = error as { name?: unknown; code?: unknown };
  if (record.name === 'SessionAttachError') return true;
  const haystack = [
    record.code,
    record.name,
    error instanceof Error ? error.message : error,
  ]
    .map((part) => String(part ?? ''))
    .join(' ');
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

export async function runRunCommand(
  args: string[],
  deps: RunCommandDeps,
): Promise<number> {
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-p' || arg === '--prompt') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: -p needs a value');
        return RUN_EXIT_USAGE;
      }
      prompt = value;
      i += 1;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --session needs a value');
        return RUN_EXIT_USAGE;
      }
      sessionId = value;
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      deps.out(`error: unknown flag ${arg}`);
      return RUN_EXIT_USAGE;
    }
  }
  if (prompt === undefined) return usage(deps.out);
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  let result: HeadlessRunResult;
  try {
    result = await deps.run(prompt, { sessionId });
    await deps.persist?.(result);
  } catch (error) {
    result = runFailure(sessionId, error);
  }
  const exitCode = mapTerminusToExitCode(result.terminus);
  if (json) {
    deps.out(JSON.stringify(buildRunEnvelope(result, exitCode)));
    return exitCode;
  }
  if (result.error !== undefined) deps.out(`error: ${result.error.message}`);
  deps.out(`result: ${result.summary}`);
  deps.out(`session: ${result.sessionId}`);
  deps.out(`journal: ${result.journalRef}`);
  deps.out(`usage: ${result.usageRef}`);
  deps.out(`trajectory: ${result.trajectoryRef}`);
  return exitCode;
}
