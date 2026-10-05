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

import type { EntryRecord, Usage } from './pi-boundary.js';

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

// Issue #433: the launch-layer rollup (`usageRows` dep + `launched.usage()`
// + this module's `summarizeUsage`) was deleted — no production supplier
// ever wired it and no caller ever read it. The single roll-up surface is
// `kubic cost --session <run>` (#164), which reads the committed session
// usage directly; duplicating it in the launch handle would fork the
// numbers. Rows are still built here for the lane's usage events.

export function formatCost(total: number): string {
  return `$${total.toFixed(2)}`;
}
