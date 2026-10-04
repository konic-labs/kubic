import { describe, expect, it } from 'vitest';
import type { AgentBudget, ReplayPin } from './budget.js';
import {
  BUDGET_LIMITS,
  BUDGET_OWNERSHIP,
  createBudget,
  diffReplayPin,
  REPLAY_PIN_DIMS,
  REPLAY_PIN_FIELDS,
  resolveBlockedSpawn,
  terminateForBudget,
} from './budget.js';

const FULL_PIN: ReplayPin = {
  task: 'task-1',
  model: 'model-a',
  thinking: 'high',
  toolSet: ['bash', 'read'],
  worktree: '/wt/1',
  baseRevision: 'abc123',
  systemPrompt: 'prompt',
  resources: ['res-1'],
};

describe('budget (issue #9, §71)', () => {
  it('createBudget({}) is empty — no smuggled defaults', () => {
    expect(createBudget({})).toEqual({});
  });

  it('createBudget keeps exactly the given fields', () => {
    const partial: AgentBudget = {
      maxTokens: 100,
      retryBudget: { maxAttempts: 3, maxCostUsd: 1 },
    };
    expect(createBudget(partial)).toEqual(partial);
  });

  it('createBudget deep-copies retryBudget so the caller object is not aliased', () => {
    const partial: AgentBudget = {
      maxTokens: 100,
      retryBudget: { maxAttempts: 3, maxCostUsd: 1 },
    };
    const budget = createBudget(partial);
    // Guard against a vacuous pass: a dropped retryBudget would skip the
    // mutation below and leave the caller object trivially intact.
    expect(budget.retryBudget).toEqual({ maxAttempts: 3, maxCostUsd: 1 });
    expect(budget.retryBudget).not.toBe(partial.retryBudget);
    if (budget.retryBudget !== undefined) {
      budget.retryBudget.maxAttempts = 99;
    }
    expect(partial.retryBudget).toEqual({ maxAttempts: 3, maxCostUsd: 1 });
  });

  it('ownership map covers all five §71 rows and nothing else', () => {
    expect([...BUDGET_LIMITS].sort()).toEqual([
      'cost',
      'retries',
      'tokens',
      'toolCalls',
      'wallClock',
    ]);
    expect(Object.keys(BUDGET_OWNERSHIP).sort()).toEqual([
      'cost',
      'retries',
      'tokens',
      'toolCalls',
      'wallClock',
    ]);
    expect(BUDGET_OWNERSHIP.tokens.enforcedBy).toMatch(/harness/);
    expect(BUDGET_OWNERSHIP.cost.enforcedBy).toMatch(/host/);
    expect(BUDGET_OWNERSHIP.wallClock.enforcedBy).toMatch(/host/);
    expect(BUDGET_OWNERSHIP.toolCalls.enforcedBy).toMatch(/before_tool/);
    expect(BUDGET_OWNERSHIP.retries.enforcedBy).toMatch(/retry/);
  });

  it('blocked spawn queues in autonomous mode', () => {
    expect(
      resolveBlockedSpawn('autonomous', 'aggregate tokens exhausted'),
    ).toEqual({
      outcome: 'queued',
    });
  });

  it('blocked spawn asks the user in interactive mode', () => {
    // §41.1/issue #277: the cap is a decision the user makes on an interactive
    // run, not a silent queue — the caller raises the spawn-agents ask.
    expect(
      resolveBlockedSpawn('interactive', 'aggregate tokens exhausted'),
    ).toEqual({
      outcome: 'ask',
      reason: 'aggregate tokens exhausted',
    });
  });

  it('terminateForBudget produces exhaustion via implementation output', () => {
    expect(terminateForBudget('toolCalls')).toEqual({
      status: 'budget_exhausted',
      limit: 'toolCalls',
    });
    expect(terminateForBudget('cost').status).not.toBe('failed');
  });
});

describe('replay pin (issue #9, §72)', () => {
  it('pin carries the six §72 dims and nothing else', () => {
    expect([...REPLAY_PIN_DIMS].sort()).toEqual([
      'baseRevision',
      'model+thinking',
      'prompt+resources',
      'task',
      'toolSet',
      'worktree',
    ]);
    expect(Object.keys(REPLAY_PIN_FIELDS).sort()).toEqual([
      'baseRevision',
      'model',
      'resources',
      'systemPrompt',
      'task',
      'thinking',
      'toolSet',
      'worktree',
    ]);
    // Values are the closed-world marker: flipping any field to false must
    // fail (mutation: BooleanLiteral true→false).
    expect(REPLAY_PIN_FIELDS).toEqual({
      task: true,
      model: true,
      thinking: true,
      toolSet: true,
      worktree: true,
      baseRevision: true,
      systemPrompt: true,
      resources: true,
    });
  });

  it('diff finds the one changed var', () => {
    expect(diffReplayPin(FULL_PIN, { ...FULL_PIN, model: 'model-b' })).toEqual([
      'model+thinking',
    ]);
  });

  it('diff is empty for identical pins', () => {
    expect(diffReplayPin(FULL_PIN, { ...FULL_PIN })).toEqual([]);
  });

  it('diff groups thinking changes under model+thinking', () => {
    expect(diffReplayPin(FULL_PIN, { ...FULL_PIN, thinking: 'low' })).toEqual([
      'model+thinking',
    ]);
  });

  it('diff groups resource-only changes under prompt+resources', () => {
    expect(
      diffReplayPin(FULL_PIN, { ...FULL_PIN, resources: ['res-2'] }),
    ).toEqual(['prompt+resources']);
  });

  it('diff groups systemPrompt-only changes under prompt+resources', () => {
    expect(
      diffReplayPin(FULL_PIN, { ...FULL_PIN, systemPrompt: 'other' }),
    ).toEqual(['prompt+resources']);
  });

  it('diff treats toolSet order as significant (conservative)', () => {
    expect(
      diffReplayPin(FULL_PIN, { ...FULL_PIN, toolSet: ['read', 'bash'] }),
    ).toEqual(['toolSet']);
  });

  it('diff reports each changed dim once', () => {
    const changed: ReplayPin = {
      ...FULL_PIN,
      task: 'task-2',
      toolSet: ['bash'],
      baseRevision: 'def456',
    };
    expect(diffReplayPin(FULL_PIN, changed).sort()).toEqual([
      'baseRevision',
      'task',
      'toolSet',
    ]);
  });

  it('diff isolates a worktree-only change (issue #70)', () => {
    expect(diffReplayPin(FULL_PIN, { ...FULL_PIN, worktree: '/wt/2' })).toEqual(
      ['worktree'],
    );
  });

  it('diff emits model+thinking once when both change (issue #70)', () => {
    expect(
      diffReplayPin(FULL_PIN, {
        ...FULL_PIN,
        model: 'model-b',
        thinking: 'low',
      }),
    ).toEqual(['model+thinking']);
  });

  it('diff emits every dim in source order when all change (issue #70)', () => {
    const changed: ReplayPin = {
      task: 'task-2',
      model: 'model-b',
      thinking: 'low',
      toolSet: ['read'],
      worktree: '/wt/2',
      baseRevision: 'def456',
      systemPrompt: 'other',
      resources: ['res-2'],
    };
    expect(diffReplayPin(FULL_PIN, changed)).toEqual([
      'task',
      'model+thinking',
      'toolSet',
      'worktree',
      'baseRevision',
      'prompt+resources',
    ]);
  });

  it('terminateForBudget covers every limit with a distinct status (issue #70)', () => {
    for (const limit of BUDGET_LIMITS) {
      const termination = terminateForBudget(limit);
      expect(termination).toEqual({ status: 'budget_exhausted', limit });
      expect(termination.status).not.toBe('failed');
    }
  });
});
