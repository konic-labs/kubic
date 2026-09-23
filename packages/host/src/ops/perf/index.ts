// Perf lane barrel (issue #55). Re-exports only — no wiring, no
// side effects; apps/kubic composition stays untouched.

export type { BudgetEvaluation, PerfBudgetKind } from './budgets.js';
export {
  ATTACH_BUDGET_MS,
  EmptySampleError,
  evaluateBudget,
  isNextSpawnUnblocked,
  isWithinBudget,
  PERF_BUDGETS_MS,
  SPAWN_BUDGET_MS,
  TEARDOWN_BUDGET_MS,
  WORKTREE_BUDGET_MS,
} from './budgets.js';
export type {
  AggregateCaps,
  GateVerdict,
  ResourceEstimate,
} from './concurrency.js';
export {
  checkPerfAggregateAdmission,
  isPerfAggregateEnforced,
} from './concurrency.js';
export { formatMergeCost, summarizeMerges } from './merge-report.js';
export type { WorkerStartChainIds, WorkerStartSpanName } from './spans.js';
export {
  closeWorkerStartChain,
  openWorkerStartChain,
  WORKER_START_CHAIN,
} from './spans.js';
export {
  assertCheapSpawnPath,
  isCheapSpawnPath,
  SpawnPathError,
} from './spawn-path.js';
