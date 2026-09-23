// Budget bundle worker facet (issue #37 dogfood). Pure limit checks that
// run on the worker side. This facet must never import pi-tui.

import type { BudgetLimits } from './contract.js';

export interface BudgetUsage {
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
}

export function checkBudgetExhausted(
  usage: BudgetUsage,
  limits: BudgetLimits,
): string | undefined {
  if (
    limits.maxTokens !== undefined &&
    usage.tokens !== undefined &&
    usage.tokens > limits.maxTokens
  ) {
    return 'tokens';
  }
  if (
    limits.maxCostUsd !== undefined &&
    usage.costUsd !== undefined &&
    usage.costUsd > limits.maxCostUsd
  ) {
    return 'cost';
  }
  if (
    limits.maxToolCalls !== undefined &&
    usage.toolCalls !== undefined &&
    usage.toolCalls > limits.maxToolCalls
  ) {
    return 'toolCalls';
  }
  return undefined;
}
