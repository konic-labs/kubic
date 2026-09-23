// Budget bundle host facet (issue #37 dogfood). Owns service registration;
// never imported by the tui facet.

import type { BudgetLimits } from './contract.js';
import { BUDGET_SERVICE } from './contract.js';

export interface BudgetHostEnv {
  provide: (name: string, impl: unknown) => void;
}

export function registerBudgetService(
  env: BudgetHostEnv,
  limits: BudgetLimits,
): void {
  env.provide(BUDGET_SERVICE, { ...limits });
}
