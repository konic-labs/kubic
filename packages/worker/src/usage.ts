// Per-request usage rollups (issue #20, slice C; §39).
// Rows arrive from the lane's routed usage events (§15); Pi sessions
// persist them. This module is pure: summarize any row list (including
// fixtures — cost tests never need network or paid tokens) and format the
// one-line model/thinking/cost readout the run status consumes.

import type { ModelThinkingLevel, Usage } from './pi-boundary.js';

export interface KubicUsageRow {
  model: string;
  provider: string;
  usage: Usage;
  ttftMs?: number;
  latencyMs?: number;
  toolCallId?: string;
  entryId?: string;
}

export interface ModelUsageSummary {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

export interface UsageSummary extends ModelUsageSummary {
  byModel: Record<string, ModelUsageSummary>;
}

function emptyModel(): ModelUsageSummary {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costTotal: 0,
  };
}

function add(into: ModelUsageSummary, row: KubicUsageRow): void {
  into.requests += 1;
  into.input += row.usage.input;
  into.output += row.usage.output;
  into.cacheRead += row.usage.cacheRead;
  into.cacheWrite += row.usage.cacheWrite;
  into.costTotal += row.usage.cost.total;
}

export function summarizeUsage(rows: KubicUsageRow[]): UsageSummary {
  const total = emptyModel();
  const byModel: Record<string, ModelUsageSummary> = {};
  for (const row of rows) {
    add(total, row);
    const slot = byModel[row.model] ?? emptyModel();
    add(slot, row);
    byModel[row.model] = slot;
  }
  return { ...total, byModel };
}

export function formatCost(total: number): string {
  return `$${total.toFixed(2)}`;
}

export function formatUsageLine(
  model: string,
  thinking: ModelThinkingLevel,
  summary: UsageSummary,
): string {
  const tokens = summary.input + summary.output;
  return `model ${model} | thinking ${thinking} | ${summary.requests} request(s), ${tokens} tokens (${formatCost(summary.costTotal)})`;
}
