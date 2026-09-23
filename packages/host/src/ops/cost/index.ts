// §62 cost optimization barrel (issue #56). New files only; no main.ts
// wiring. Re-exports the ordered levers plus the per-agent cost surface.

export type { CachePreservationVerdict, PrefixHitRate } from './cache.js';
export {
  checkCachePreservation,
  prefixHitRate,
  transparentCachingNote,
} from './cache.js';
export type {
  CompactReuseDecision,
  CompactReuseInput,
} from './compact-reuse.js';
export { decideCompactReuse } from './compact-reuse.js';
export type { CostEscalationRecord, CostLadder } from './escalation.js';
export {
  compareEscalationValue,
  createCostLadder,
  escalateCost,
  requiresFreshSessionForDeescalation,
} from './escalation.js';
export type { CostLever, LeverOrderVerdict } from './order.js';
export { assertLeverOrder, COST_LEVERS, nextRequiredLever } from './order.js';
export { applyOutputLimit, validateOutputLimit } from './output-limits.js';
export type {
  AgentCostEntry,
  AgentCostInput,
  CostJsonShape,
  PerAgentCostSummary,
} from './per-agent-cost.js';
export {
  formatAgentCostRow,
  summarizePerAgentCost,
  toCostJson,
} from './per-agent-cost.js';
export type { ExactCacheStats, ExactResponseCache } from './response-cache.js';
export {
  createExactCache,
  SEMANTIC_DEFERRED_NOTE,
  semanticLookup,
} from './response-cache.js';
export type { RetryBudgetCap, RetryLedger } from './retry-ledger.js';
export { canRetry, chargeRetry, createRetryLedger } from './retry-ledger.js';
export type {
  RoleModelRef,
  RoleModelSelection,
  RoleModelTable,
} from './role-model.js';
export { selectRoleModel } from './role-model.js';
export type { SpawnGateInput, SpawnGateVerdict } from './spawn-gate.js';
export { gateSpawn } from './spawn-gate.js';
