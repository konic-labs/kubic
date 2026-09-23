// Merge coordination surface (issue #46).
// Re-exports only — no CLI wiring here (composition root owns that).

export type {
  AttributedHunk,
  JournalEntryRef,
  MergedHunk,
} from './attribution.js';
export {
  attributeMergedHunks,
  diffArgsForAgent,
  filterEntriesByAgent,
} from './attribution.js';
export type {
  ApprovalSnapshot,
  ConflictRecord,
  ResolverRole,
  ResolverSpawnSpec,
  ResolverSpecInput,
} from './conflicts.js';
export {
  approvalSnapshotsEqual,
  buildResolverSpec,
  DEBUGGER_TOOLSET,
  filesInDiff,
  hashApprovalPolicy,
  IMPLEMENTER_TOOLSET,
  RESOLVER_ALLOWED_ROLES,
  ResolverPolicyError,
} from './conflicts.js';
export type {
  BlockedConflict,
  MergeCandidate,
  MergeQueue,
  QueueStatus,
} from './queue.js';
export { createMergeQueue, QueueStoppedError } from './queue.js';
export type { ApplyDecision, ReviewResult, ReviewVerdict } from './review.js';
export {
  assertReviewerReadonly,
  decideApplyAfterReview,
  REVIEWER_READONLY_TOOLS,
  ReviewerScopeError,
} from './review.js';
export {
  assertManagerZeroWrites,
  MANAGER_MERGE_ALLOWLIST,
  MANAGER_WRITE_TOOLS,
  ManagerAuthoringError,
} from './settle.js';
export type { MergeOutcome, MergeTelemetry } from './telemetry.js';
export { recordMergeTelemetry, totalMergeMs } from './telemetry.js';
