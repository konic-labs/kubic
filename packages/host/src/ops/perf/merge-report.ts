// Per-agent merge reporting hook (issue #55; §61).
// Merge cost per agent lands in the run summary: one line per settled
// agent with the five §46 phases and their total. Deliberately no fixed
// budget — merge cost is reported, never gated. Pure: reads the §46
// MergeTelemetry record read-only, never imports lifecycle/worktree.

import type { MergeTelemetry } from '../../orchestrator/merge/telemetry.js';
import { totalMergeMs } from '../../orchestrator/merge/telemetry.js';

export function formatMergeCost(record: MergeTelemetry): string {
  return (
    `agent=${record.agentId} merge total=${totalMergeMs(record)}ms ` +
    `(queue=${record.queueMs}ms diff=${record.diffMs}ms ` +
    `merge=${record.mergeMs}ms resolve=${record.resolveMs}ms ` +
    `apply=${record.applyMs}ms) outcome=${record.outcome}`
  );
}

export function summarizeMerges(records: readonly MergeTelemetry[]): string[] {
  return records.map((record) => formatMergeCost(record));
}
