// Budget bundle tui facet (issue #37 dogfood). Read-only status text.
// This facet imports the contract facet only — never host.

import type { BudgetLimits } from './contract.js';

export function renderBudgetStatus(limits: BudgetLimits): string {
  const parts: string[] = [];
  if (limits.maxTokens !== undefined) parts.push(`tokens≤${limits.maxTokens}`);
  if (limits.maxCostUsd !== undefined) parts.push(`cost≤$${limits.maxCostUsd}`);
  if (limits.maxRuntimeMs !== undefined)
    parts.push(`wall≤${limits.maxRuntimeMs}ms`);
  if (limits.maxToolCalls !== undefined)
    parts.push(`calls≤${limits.maxToolCalls}`);
  if (parts.length === 0) return 'budget: none configured';
  return `budget: ${parts.join(' ')}`;
}
