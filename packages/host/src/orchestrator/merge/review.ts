// Reviewer-before-apply (issue #46; §70).
// The reviewer is read-only (empty write scope — findings travel back
// as text, never as edits). Its verdict routes the manager: accept →
// workspace_apply, request-changes / escalate → discard. The manager
// applies or discards; the reviewer never does. Pure — no I/O.

export const REVIEWER_READONLY_TOOLS = [
  'read',
  'ls',
  'find',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
] as const;

export class ReviewerScopeError extends Error {
  constructor(toolName: string) {
    super(
      `reviewer policy block: '${toolName}' is outside the read-only scope — findings travel back as text, never as edits`,
    );
    this.name = 'ReviewerScopeError';
  }
}

export function assertReviewerReadonly(reviewerCalls: readonly string[]): void {
  for (const call of reviewerCalls) {
    if (!(REVIEWER_READONLY_TOOLS as readonly string[]).includes(call)) {
      throw new ReviewerScopeError(call);
    }
  }
}

export type ReviewVerdict = 'accept' | 'request-changes' | 'escalate';

export interface ReviewResult {
  verdict: ReviewVerdict;
}

export type ApplyDecision = 'apply' | 'discard';

export function decideApplyAfterReview(review: ReviewResult): ApplyDecision {
  return review.verdict === 'accept' ? 'apply' : 'discard';
}
