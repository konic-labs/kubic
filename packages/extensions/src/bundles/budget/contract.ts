// Budget bundle contract facet (issue #37 dogfood). Narrow, non-secret
// view over the agents budget surface. Read-only shape reference — the
// agents package is never modified from here.

export const BUDGET_SERVICE = 'budget/limits';

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  maxToolCalls?: number;
}

export interface BudgetStatus {
  configured: boolean;
  limits: BudgetLimits;
}
