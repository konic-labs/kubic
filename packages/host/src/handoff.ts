// Handoff assembly + review-loop state machine (issue #8; §69, §70).
// A handoff carries the structured result, artifact REFERENCES (never
// contents), a diff reference, the worktree, and the constraint list — never
// a transcript, which keeps a five-agent chain affordable (§69).
//
// Review loop (§70): planner → implementer → tester → reviewer → root, with
// failures routing to the debugger (tester failures NEVER re-plan) and a
// maxAttempts bound per chain before escalation. The reviewer is read-only:
// reviewer handoffs carry an empty write scope.

import type { AgentResult } from '../../worker/src/result.js';

export type WriteScope = 'none' | 'worktree';

export interface Handoff {
  result: AgentResult;
  artifactIds: string[];
  diffId?: string;
  worktree: string;
  constraints: string[];
  writeScope: WriteScope;
}

// Closed-world field coverage: §69 fixes the handoff contents exactly.
export const HANDOFF_FIELDS = {
  result: true,
  artifactIds: true,
  diffId: true,
  worktree: true,
  constraints: true,
  writeScope: true,
} satisfies Record<keyof Handoff, true>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type HandoffValidation =
  | { valid: true; task: Handoff }
  | { valid: false; errors: string[] };

export function validateHandoff(input: unknown): HandoffValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['handoff must be an object'] };

  if ('transcript' in input) {
    errors.push('handoff must not carry a transcript (§69)');
  }
  if (!isObject(input.result)) errors.push('result must be present');
  if (!Array.isArray(input.artifactIds))
    errors.push('artifactIds must be an array');
  if (!isNonEmptyString(input.worktree)) {
    errors.push('worktree must be a non-empty string');
  } else if (!input.worktree.startsWith('/')) {
    errors.push('worktree must be an absolute path');
  }
  if (!Array.isArray(input.constraints))
    errors.push('constraints must be an array');
  if (input.writeScope !== 'none' && input.writeScope !== 'worktree') {
    errors.push('writeScope must be none or worktree');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, task: input as unknown as Handoff };
}

// Reviewer handoffs are read-only: same payload, empty write scope.
export function forReviewer(handoff: Handoff): Handoff {
  return { ...handoff, writeScope: 'none' };
}

export const REVIEW_STAGES = [
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'debugger',
  'root',
  'done',
  'escalated',
] as const;

export type ReviewStage = (typeof REVIEW_STAGES)[number];

export interface ReviewState {
  stage: ReviewStage;
  attempts: number;
  maxAttempts: number;
}

export type ReviewStep =
  | { next: Exclude<ReviewStage, 'escalated' | 'planner'>; state: ReviewState }
  | { next: 'escalate'; reason: string; state: ReviewState };

export type ReviewSignal = 'pass' | 'fail';

export function nextReviewStep(
  state: ReviewState,
  signal: ReviewSignal,
  reason = 'no reason given',
): ReviewStep {
  if (state.stage === 'done') return { next: 'done', state };
  if (state.stage === 'escalated') {
    return { next: 'escalate', reason: 'already escalated', state };
  }

  if (signal === 'pass') {
    const forward: Record<
      string,
      Exclude<ReviewStage, 'escalated' | 'planner'>
    > = {
      planner: 'implementer',
      implementer: 'tester',
      tester: 'reviewer',
      reviewer: 'root',
      debugger: 'tester',
      root: 'done',
    };
    const next = forward[state.stage] ?? 'done';
    return { next, state: { ...state, stage: next } };
  }

  // Fail: planner failures escalate (nothing exists to debug yet); every
  // other failure goes to the debugger — tester failures NEVER re-plan.
  if (state.stage === 'planner' || state.stage === 'root') {
    return {
      next: 'escalate',
      reason: `${state.stage} failed: ${reason}`,
      state,
    };
  }
  if (state.attempts >= state.maxAttempts) {
    return {
      next: 'escalate',
      reason: `maxAttempts (${state.maxAttempts}) exhausted at ${state.stage}: ${reason}`,
      state,
    };
  }
  const retried: ReviewState = {
    ...state,
    stage: 'debugger',
    attempts: state.attempts + 1,
  };
  return { next: 'debugger', state: retried };
}
