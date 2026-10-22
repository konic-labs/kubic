// Per-request usage rollups.
// Rows arrive from the lane's routed usage events; pi sessions
// persist them. This module is pure: summarize any row list (including
// fixtures — cost tests never need network or paid tokens) and format the
// one-line model/thinking/cost readout the run status consumes.
// The rows are built from committed pi.assistant entries, so the
// provider/model are the ones that really answered.
//
// Pi 1.0 reports no timing that Kubic can read, so there are no ttftMs or
// latencyMs fields: a field nothing writes is the defect.

import type { EntryRecord, Usage } from './pi-boundary.js';

export interface KubicUsageRow {
  model: string;
  provider: string;
  usage: Usage;
  toolCallId?: string;
  entryId?: string;
}

// The per-response row of one committed assistant entry: the message's own
// provider/model (never the lane name or the boot model) and its
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

// The single roll-up surface is `kubic cost --session <run>`, which reads
// the committed session usage directly. Rows are built here for the lane's
// usage events.
