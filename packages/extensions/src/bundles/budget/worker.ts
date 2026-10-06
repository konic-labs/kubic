// Budget bundle worker facet (issue #37 dogfood). Pure limit checks that
// run on the worker side. This facet must never import pi-tui.

import type { BudgetLimits } from './contract.js';

export interface BudgetUsage {
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  // Issue #283 (§71): wall-clock milliseconds for `maxRuntimeMs`.
  runtimeMs?: number;
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
  // Issue #283 (§71): elapsed wall-clock past `maxRuntimeMs` exhausts
  // as 'wallClock' — checked last so a count breach names its own
  // dimension first.
  if (
    limits.maxRuntimeMs !== undefined &&
    usage.runtimeMs !== undefined &&
    usage.runtimeMs > limits.maxRuntimeMs
  ) {
    return 'wallClock';
  }
  return undefined;
}
