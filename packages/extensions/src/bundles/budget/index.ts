// Budget bundle wiring (issue #37 dogfood). Ships the agents budget
// surface as a first-party bundle through the public loader path:
// manifest (publisher kubic, owned source) + factory + async onActivate.
// Delegates to the real agents createBudget — no defaults smuggled.

import { createBudget } from '../../../../agents/src/budget.js';
import type { ExtensionManifest } from '../../contract.js';
import type { ActivationEnv, BundleFactory } from '../../loader.js';
import type { BudgetLimits } from './contract.js';
import { BUDGET_SERVICE } from './contract.js';
import { registerBudgetService } from './host.js';

export const BUDGET_MANIFEST: ExtensionManifest = {
  name: 'kubic/budget',
  publisher: 'kubic',
  version: '0.0.0',
  sourcePath: 'kubic/budget',
  facets: ['contract', 'host', 'worker', 'tui'],
};

export interface BudgetBundle {
  manifest: ExtensionManifest;
  factory: BundleFactory;
}

export function createBudgetBundle(limits: BudgetLimits): BudgetBundle {
  const factory: BundleFactory = (env: ActivationEnv) => {
    const budget = createBudget(limits);
    registerBudgetService(
      { provide: (name, impl) => env.provide?.(name, impl) },
      budget,
    );
    void BUDGET_SERVICE;
    return {
      onActivate: async () => undefined,
    };
  };
  return { manifest: BUDGET_MANIFEST, factory };
}
