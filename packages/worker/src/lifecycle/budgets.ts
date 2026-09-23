// §61 lifecycle perf budgets (issue #42): worktree<300ms, spawn<200ms,
// attach<50ms, teardown<1s non-blocking. Pure threshold checks — the CI
// gate calls checkPerfGate, never wall-clock sleeps.

export const LIFECYCLE_BUDGETS_MS = {
  worktreeMs: 300,
  spawnMs: 200,
  attachMs: 50,
  teardownMs: 1000,
} as const;

export interface PerfSample {
  spawnMs: number;
  startupMs?: number;
  attachMs?: number;
  worktreeMs?: number;
  teardownInitiateMs: number;
  teardownSettledMs: number;
}

export interface PerfGateResult {
  ok: boolean;
  breaches: string[];
}

export function checkPerfGate(sample: PerfSample): PerfGateResult {
  const breaches: string[] = [];
  if (sample.spawnMs > LIFECYCLE_BUDGETS_MS.spawnMs) {
    breaches.push(
      `spawn ${sample.spawnMs}ms exceeds ${LIFECYCLE_BUDGETS_MS.spawnMs}ms warm budget`,
    );
  }
  if (
    sample.attachMs !== undefined &&
    sample.attachMs > LIFECYCLE_BUDGETS_MS.attachMs
  ) {
    breaches.push(
      `attach ${sample.attachMs}ms exceeds ${LIFECYCLE_BUDGETS_MS.attachMs}ms budget`,
    );
  }
  if (
    sample.worktreeMs !== undefined &&
    sample.worktreeMs > LIFECYCLE_BUDGETS_MS.worktreeMs
  ) {
    breaches.push(
      `worktree ${sample.worktreeMs}ms exceeds ${LIFECYCLE_BUDGETS_MS.worktreeMs}ms budget`,
    );
  }
  if (sample.teardownSettledMs > LIFECYCLE_BUDGETS_MS.teardownMs) {
    breaches.push(
      `teardown settled ${sample.teardownSettledMs}ms exceeds ${LIFECYCLE_BUDGETS_MS.teardownMs}ms budget (must be non-blocking)`,
    );
  }
  return { ok: breaches.length === 0, breaches };
}
