import { describe, expect, it } from 'vitest';
import type { Handoff, ReviewState } from './handoff.js';
import {
  forReviewer,
  HANDOFF_FIELDS,
  nextReviewStep,
  REVIEW_STAGES,
  validateHandoff,
} from './handoff.js';

function validHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    result: {
      status: 'completed',
      summary: 'done',
      filesChanged: ['src/a.ts'],
      provenance: { workerId: 'worker-1' },
      metrics: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        toolCalls: 1,
        latencyMs: 10,
        wallMs: 12,
      },
    },
    artifactIds: ['a1'],
    diffId: 'd1',
    worktree: '/tmp/wt-1',
    constraints: ['no network'],
    writeScope: 'worktree',
    ...overrides,
  };
}

function stateAt(stage: ReviewState['stage'], attempts = 0): ReviewState {
  return { stage, attempts, maxAttempts: 2 };
}

describe('handoff (issue #8, §69)', () => {
  it('carries exactly result + refs + diff + worktree + constraints + writeScope', () => {
    expect(Object.keys(HANDOFF_FIELDS).sort()).toEqual([
      'artifactIds',
      'constraints',
      'diffId',
      'result',
      'worktree',
      'writeScope',
    ]);
  });

  it('accepts a valid handoff', () => {
    expect(validateHandoff(validHandoff()).valid).toBe(true);
  });

  it('rejects a transcript field', () => {
    const result = validateHandoff({ ...validHandoff(), transcript: '...' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/transcript/);
  });

  it('reviewer handoff carries empty write scope', () => {
    expect(forReviewer(validHandoff()).writeScope).toBe('none');
  });

  it('JSON round-trip preserves validity and shape', () => {
    const handoff = validHandoff();
    const revived: unknown = JSON.parse(JSON.stringify(handoff));
    const result = validateHandoff(revived);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.task).toEqual(handoff);
  });
});

describe('review loop (issue #8, §70)', () => {
  it('lists the §70 stages', () => {
    expect([...REVIEW_STAGES]).toEqual([
      'planner',
      'implementer',
      'tester',
      'reviewer',
      'debugger',
      'root',
      'done',
      'escalated',
    ]);
  });

  it('golden path reaches done', () => {
    const stages: string[] = [];
    let state = stateAt('planner');
    for (let i = 0; i < 6; i++) {
      const step = nextReviewStep(state, 'pass');
      if (step.next === 'escalate') throw new Error('unexpected escalation');
      stages.push(step.next);
      state = step.state;
    }
    expect(stages).toEqual([
      'implementer',
      'tester',
      'reviewer',
      'root',
      'done',
      'done',
    ]);
  });

  it('tester fail routes to debugger, never planner', () => {
    const step = nextReviewStep(stateAt('tester'), 'fail', 'tests red');
    expect(step.next).toBe('debugger');
    if (step.next === 'debugger') expect(step.state.attempts).toBe(1);
  });

  it('debugger pass returns to tester', () => {
    const step = nextReviewStep(stateAt('debugger', 1), 'pass');
    if (step.next === 'escalate') throw new Error('unexpected escalation');
    expect(step.next).toBe('tester');
  });

  it('maxAttempts exhaustion escalates with reason', () => {
    const step = nextReviewStep(stateAt('debugger', 2), 'fail', 'still red');
    expect(step.next).toBe('escalate');
    if (step.next === 'escalate') expect(step.reason).toMatch(/maxAttempts/);
  });
});
