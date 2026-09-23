// Parallel subagents surface (issue #47; §45, §45.1, §81).
// Re-exports only — no CLI wiring here (composition root owns that).

export type {
  AggregateCaps,
  BudgetGate,
  GateVerdict,
  ParallelLimits,
  ProviderCap,
  ProviderCaps,
  ResourceEstimate,
  UsageTally,
} from './limits.js';
export {
  checkAggregateAdmission,
  checkBudgetAdmission,
  checkProviderAdmission,
  DEFAULT_MAX_CONCURRENCY,
  isAggregateConfigured,
  isBudgetGateConfigured,
  ParallelConfigError,
  resolveMaxConcurrency,
  resolveWorkerCapacity,
  validateParallelLimits,
} from './limits.js';
export type {
  SchedulerDeps,
  SpawnOutcome,
  SpawnRequest,
} from './scheduler.js';
export {
  DEFAULT_MAX_PENDING_MS,
  ParallelScheduler,
  sanitizeLogLine,
} from './scheduler.js';
export type {
  ParallelConc,
  ParallelSnapshot,
  ParallelTrajectoryEvent,
  ParallelUsage,
  ParallelWorkersExtra,
} from './visibility.js';
export {
  buildParallelTrajectoryEvent,
  buildParallelTreeLine,
  buildParallelWorkersExtra,
} from './visibility.js';
