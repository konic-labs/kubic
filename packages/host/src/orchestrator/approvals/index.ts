// Orchestrator approvals surface (issue #48).
// Re-exports only — no CLI wiring here (composition root owns that).

export type {
  BeforeToolEvent,
  BeforeToolVerdict,
  BudgetGate,
  BudgetLimit,
  BudgetTermination,
  BudgetTrajectoryEvent,
  BudgetUsage,
  BurnDownState,
  OrchestratorBudget,
  RetryBudgetConfig,
  SelfRaiseRefusal,
} from './budgets.js';
export {
  BUDGET_EXHAUSTED,
  buildBudgetTrajectoryEvent,
  checkBudgetExhaustion,
  createBudgetGate,
  createBurnDown,
  OrchestratorBudgetError,
  RUN_EXIT_BUDGET,
  recordToolCall,
  refuseSelfRaise,
  validateOrchestratorBudget,
} from './budgets.js';
export type {
  OrchestratorApprovalRequest,
  OrchestratorProvenance,
  OrchestratorRequestInput,
  OrchestratorTrigger,
} from './request.js';
export {
  buildOrchestratorRequest,
  ORCHESTRATOR_TRIGGERS,
  OrchestratorRequestError,
  orchestratorRequestKey,
  validateOrchestratorRequest,
} from './request.js';
export type {
  DecisionStore,
  ManagerBlockedIndicator,
  OrchestratorRouter,
  OrchestratorVerdict,
  RouterOptions,
} from './routing.js';
export {
  attemptManagerApprove,
  buildManagerBlockedIndicator,
  createOrchestratorRouter,
  MemoryDecisionStore,
} from './routing.js';
export type {
  SessionRef,
  SessionSkipAuditEvent,
  SessionSkipRecord,
} from './skip.js';
export {
  buildSessionSkipAuditEvent,
  buildSessionSkipDoctorCheck,
  disableSessionSkip,
  enableSessionSkip,
  formatSessionSkipIndicator,
  isSessionSkipEnabled,
} from './skip.js';
