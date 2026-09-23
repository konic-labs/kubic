// Per-agent merge telemetry (issue #46; §61).
// Phase timings per settled agent: queue wait, workspace_diff,
// workspace_merge, writer-resolver rework, workspace_apply. Totals are
// additive — resolveMs is reported apart, never folded into mergeMs.
// Pure — the SpanRecorder (§29) owns aggregation; this is the record.

export type MergeOutcome =
  | 'merged'
  | 'resolved-merged'
  | 'discarded'
  | 'stopped-unresolvable';

export interface MergeTelemetry {
  agentId: string;
  queueMs: number;
  diffMs: number;
  mergeMs: number;
  resolveMs: number;
  applyMs: number;
  outcome: MergeOutcome;
}

export function recordMergeTelemetry(record: MergeTelemetry): MergeTelemetry {
  return { ...record };
}

export function totalMergeMs(record: MergeTelemetry): number {
  return (
    record.queueMs +
    record.diffMs +
    record.mergeMs +
    record.resolveMs +
    record.applyMs
  );
}
