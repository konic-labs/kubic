// Per-agent merge telemetry (issue #46; §61).
// Phase timings per settled agent: queue wait, workspace_diff,
// workspace_merge, writer-resolver rework (resolveMs), workspace_apply.
// totalMergeMs is the sum of ALL five phases: resolveMs is tracked
// separately from mergeMs (mergeMs covers workspace_merge only) but IS
// included in the total — resolveMs is never folded into mergeMs
// itself. Pure — the SpanRecorder (§29) owns aggregation; this is the
// record.

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
