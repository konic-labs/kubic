// Shared RL dataset shapes.
// Every exported record embeds provenance (proc/gen/worktree/model/base)
// plus the failure category. Validation is fail-closed: stripped
// provenance or labels are errors, never warnings. Env-vs-capability
// policy: runs carrying an env failure code must never train capability
// preference — pair builders exclude (and tag) them.
// Read-only reuse: the trajectory shape is consumed structurally via the
// stable TrajectoryExport contract (major 1); the transfer snapshot
// {taskId, worktree, grantRef} mirrors the agents TransferLogRecord
// without importing it; pair records carry refs only.
import {
  isTrajectoryFailureCode,
  type TrajectoryExport,
  type TrajectoryFailureCode,
} from '../../../trajectory/src/schema.js';

// Failure codes (worker-owned spelling, pinned in trajectory schema).
export type { TrajectoryFailureCode };
export { isTrajectoryFailureCode };

// Provenance embedded in every RL record: the OS process (explicit null
// for faux runs — never silently dropped), worker generation, worktree,
// model, and base revision the run executed against.
export interface RlProvenance {
  proc: number | null;
  gen: number;
  worktree: string;
  model: string;
  base: string;
}

export class RlProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlProvenanceError';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Fail-closed: a record that cannot be attributed to a process +
// generation + worktree + model + base cannot be reproduced, so it is
// refused rather than emitted labelless.
export function extractProvenance(exported: TrajectoryExport): RlProvenance {
  const provenance = exported.provenance;
  const pid = provenance?.pid ?? null;
  if (pid !== null && (typeof pid !== 'number' || !Number.isInteger(pid))) {
    throw new RlProvenanceError('provenance.proc must be an integer or null');
  }
  if (
    typeof provenance?.generation !== 'number' ||
    !Number.isInteger(provenance.generation) ||
    !(provenance.generation >= 0)
  ) {
    throw new RlProvenanceError(
      'provenance.gen is required: record which worker generation ran',
    );
  }
  if (!nonEmpty(provenance?.worktree)) {
    throw new RlProvenanceError(
      'provenance.worktree is required: record how the run executed',
    );
  }
  if (!nonEmpty(provenance?.model)) {
    throw new RlProvenanceError('provenance.model is required');
  }
  if (!nonEmpty(exported.worktree?.baseRevision)) {
    throw new RlProvenanceError(
      'provenance.base is required: record the base revision',
    );
  }
  return {
    proc: pid,
    gen: provenance.generation,
    worktree: provenance.worktree,
    model: provenance.model,
    base: exported.worktree.baseRevision,
  };
}

export type FailureLabelCheck =
  | { ok: true; category: TrajectoryFailureCode | null }
  | { ok: false; errors: string[] };

// Failure category gate: completed runs carry null; every non-completed
// result must carry its failure code (trajectory contract). Unknown
// codes and stripped labels are errors, never warnings.
export function requireFailureLabel(
  exported: TrajectoryExport,
): FailureLabelCheck {
  const category = exported.result?.failureCategory ?? null;
  if (category === null) {
    if (exported.result?.status !== 'completed') {
      return {
        ok: false,
        errors: [
          `failureCategory is required on non-completed result ${JSON.stringify(exported.result?.status)} `,
        ],
      };
    }
    return { ok: true, category: null };
  }
  if (typeof category !== 'string' || !isTrajectoryFailureCode(category)) {
    return {
      ok: false,
      errors: [`unknown failure category ${JSON.stringify(category)}`],
    };
  }
  return { ok: true, category };
}

// Env failure codes: the run failed for environment reasons (tool,
// workspace, spawn, or provider), so it carries no capability signal —
// pair builders must exclude (and tag) runs carrying these instead of
// teaching the model that env breakage is a capability difference.
// Capability codes (model_*, context_*, run_limit, approval_*,
// tool_invalid_args) stay eligible.
export const ENV_FAILURE_CODES = [
  'tool_failed',
  'tool_timeout',
  'tool_unavailable',
  'workspace_failed',
  'process_crashed',
  'process_spawn_failed',
  'provider_transient',
  'provider_auth',
] as const;

export type EnvFailureCode = (typeof ENV_FAILURE_CODES)[number];

export function isEnvFailure(
  category: TrajectoryFailureCode | string | null,
): boolean {
  if (typeof category !== 'string') return false;
  return (ENV_FAILURE_CODES as readonly string[]).includes(category);
}
