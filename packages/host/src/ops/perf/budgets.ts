// Worker overhead perf budgets (issue #55; §61, §81).
// Explicit ms constants — worktree<300ms, spawn<200ms, attach<50ms,
// teardown<1s non-blocking — plus p50/p95 CI gates per budget. A gate
// failure files a regression naming kind/p95/budget. Pure: injected
// samples only, no clock, no I/O, no network (faux-only).

export const WORKTREE_BUDGET_MS = 300;
export const SPAWN_BUDGET_MS = 200;
export const ATTACH_BUDGET_MS = 50;
export const TEARDOWN_BUDGET_MS = 1000;

export type PerfBudgetKind = 'worktree' | 'spawn' | 'attach' | 'teardown';

export const PERF_BUDGETS_MS: Record<PerfBudgetKind, number> = {
  worktree: WORKTREE_BUDGET_MS,
  spawn: SPAWN_BUDGET_MS,
  attach: ATTACH_BUDGET_MS,
  teardown: TEARDOWN_BUDGET_MS,
};

export function isWithinBudget(
  kind: PerfBudgetKind,
  elapsedMs: number,
): boolean {
  return elapsedMs < PERF_BUDGETS_MS[kind];
}

// Teardown is non-blocking (§61): N teardowns must each fit the teardown
// budget AND leave the next spawn's attach within the attach budget.
// Either side blowing its budget means teardown delayed the next spawn.
export function isNextSpawnUnblocked(
  teardownElapsedMs: readonly number[],
  nextAttachMs: number,
): boolean {
  return (
    teardownElapsedMs.every((elapsed) => isWithinBudget('teardown', elapsed)) &&
    isWithinBudget('attach', nextAttachMs)
  );
}

export interface BudgetEvaluation {
  kind: PerfBudgetKind;
  budgetMs: number;
  count: number;
  p50: number;
  p95: number;
  within: boolean;
  regression: string | null;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

export function evaluateBudget(
  kind: PerfBudgetKind,
  samplesMs: readonly number[],
): BudgetEvaluation {
  const budgetMs = PERF_BUDGETS_MS[kind];
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const within = p95 <= budgetMs;
  return {
    kind,
    budgetMs,
    count: samplesMs.length,
    p50,
    p95,
    within,
    regression: within
      ? null
      : `perf regression: ${kind} p95=${p95}ms exceeds budget=${budgetMs}ms (n=${samplesMs.length}, p50=${p50}ms)`,
  };
}
