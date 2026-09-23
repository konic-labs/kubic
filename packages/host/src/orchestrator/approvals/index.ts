// Orchestrator approvals surface (issue #48).
// Re-exports only — no CLI wiring here (composition root owns that).

export type {
  BeforeToolEvent,
  BeforeToolVerdict,
  BudgetGate,
  BudgetLimit,
  BudgetRaiseResult,
  BudgetTermination,
  BudgetTrajectoryEvent,
  BudgetUsage,
  BurnDownState,
  OrchestratorBudget,
  RetryBudgetConfig,
  SelfRaiseRefusal,
  UserBudgetApproval,
} from './budgets.js';
export {
  applyBudgetRaise,
  BUDGET_EXHAUSTED,
  buildBudgetTrajectoryEvent,
  checkBudgetExhaustion,
  createBudgetGate,
  createBurnDown,
  mintUserBudgetApproval,
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
  MIN_JUSTIFICATION_ALNUM,
  MIN_JUSTIFICATION_LENGTH,
  normalizeJustification,
  ORCHESTRATOR_TRIGGERS,
  OrchestratorRequestError,
  orchestratorRequestKey,
  validateOrchestratorRequest,
} from './request.js';
export type {
  DecisionStore,
  ManagerBlockedIndicator,
  ManagerRefusalEvent,
  OrchestratorRouter,
  OrchestratorVerdict,
  RouterAuditEvent,
  RouterOptions,
} from './routing.js';
export {
  attemptManagerApprove,
  buildManagerBlockedIndicator,
  createOrchestratorRouter,
  MemoryDecisionStore,
  readManagerRefusalLog,
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
  MAX_SESSION_SKIP_TTL_MS,
  SessionSkipError,
} from './skip.js';
