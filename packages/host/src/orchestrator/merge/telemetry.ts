// Per-agent merge telemetry (issue #46; §61).
// Phase timings per settled agent: queue wait, workspace_diff,
// workspace_merge, writer-resolver rework (resolveMs), workspace_apply.
// totalMergeMs is the sum of ALL five phases: resolveMs is tracked
// separately from mergeMs (mergeMs covers workspace_merge only) but IS
// included in the total — resolveMs is never folded into mergeMs
// itself. The approval gate's wait is in NO phase (issue #158 review): it is
// human-paced, and §61 budgets the merge, not the user's answer.
// Pure — the SpanRecorder (§29) owns aggregation; this is the record.

export type MergeOutcome =
  | 'merged'
  | 'resolved-merged'
  // The candidate's branch did not land this run: the merge itself threw, so
  // the branch and worktree stay as evidence (§44.1) and `state.pending` keeps
  // the worker for `--resume`. Never "discarded" — nothing is thrown away.
  | 'merge-failed'
  | 'stopped-unresolvable'
  // The merge gate's verdict ended the candidate before any merge leg ran.
  | 'approval-denied'
  | 'approval-timeout'
  // The reviewer refused the diff (issue #188, §70): recorded under
  // `discarded`, the branch stays for inspection, resume never retries.
  | 'review-discarded';

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
