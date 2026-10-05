// Per-request usage rollups (issue #20, slice C; §39).
// Rows arrive from the lane's routed usage events (§15); pi sessions
// persist them. This module is pure: summarize any row list (including
// fixtures — cost tests never need network or paid tokens) and format the
// one-line model/thinking/cost readout the run status consumes. Since
// #398 the rows are built from committed pi.assistant entries, so the
// provider/model are the ones that really answered (#287).
//
// Issue #346: the never-written ttftMs/latencyMs fields were deleted with
// the status bar's TTFT/tool-ms segments — Pi 1.0 reports no timing Kubic
// can read, and dead fields are the defect.

import type { EntryRecord, ModelThinkingLevel, Usage } from './pi-boundary.js';

export interface KubicUsageRow {
  model: string;
  provider: string;
  usage: Usage;
  toolCallId?: string;
  entryId?: string;
}

// The per-response row of one committed assistant entry: the message's own
// provider/model (never the lane name or the boot model — #287) and its
// usage, plus the transcript handle the row came from. Non-assistant
// entries (user input, tool results, compaction summaries) have no model
// response to bill and yield nothing.
export function usageRowFromEntry(
  entry: EntryRecord,
): KubicUsageRow | undefined {
  const message = entry.model?.[0];
  if (message?.role !== 'assistant') return undefined;
  return {
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    entryId: String(entry.id),
  };
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
