import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, SpawnRequest, SubagentSpec } from './spec.js';
import {
  allocateGeneration,
  buildSubagentResult,
  createGenerationState,
  forkSessionConfig,
  openChildSession,
  provenanceFor,
  SUBAGENT_SPEC_FIELDS,
  spawnAgent,
  specKeyOf,
  validateGenerationSend,
  validateSubagentResult,
  validateSubagentSpec,
} from './spec.js';
import type { AgentTask } from './task.js';

function validSpec(overrides: Partial<SubagentSpec> = {}): SubagentSpec {
  return {
    sessionId: 'child-1',
    parentSessionId: 'parent-1',
    role: 'implementer',
    model: { provider: 'acme', model: 'm1', thinking: 'high' },
    systemPrompt: 'You implement.',
    resources: { skills: ['tdd'] },
    toolNames: ['bash', 'read'],
    worktreePath: '/tmp/wt-child-1',
    generation: 1,
    ...overrides,
  };
}

describe('subagent spec (issue #41, §6.2)', () => {
  it('field list matches §6.2 exactly', () => {
    expect(Object.keys(SUBAGENT_SPEC_FIELDS).sort()).toEqual(
      [
        'budget',
        'generation',
        'model',
        'parentSessionId',
        'resources',
        'role',
        'sessionId',
        'systemPrompt',
        'toolNames',
        'worktreePath',
      ].sort(),
    );
  });

  it('accepts a minimal valid spec', () => {
    const { systemPrompt: _s, resources: _r, ...minimal } = validSpec();
    const result = validateSubagentSpec(minimal);
    expect(result.valid).toBe(true);
  });

  it('accepts a spec with an optional budget', () => {
    const result = validateSubagentSpec(
      validSpec({ budget: { maxTokens: 100 } }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.spec.budget).toEqual({ maxTokens: 100 });
  });

  it('rejects a missing worktreePath', () => {
    const { worktreePath: _dropped, ...noWorktree } = validSpec();
    const result = validateSubagentSpec(noWorktree);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/worktreePath/);
  });

  it('rejects a relative worktreePath', () => {
    const result = validateSubagentSpec(
      validSpec({ worktreePath: 'relative/path' }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/worktreePath/);
  });

  it('rejects a child sessionId equal to its parent', () => {
    const result = validateSubagentSpec(validSpec({ sessionId: 'parent-1' }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/parent/);
  });
});

function validTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: 'task-1',
    parentSessionId: 'parent-1',
    role: 'implementer',
    objective: 'Implement the widget',
    worktree: '/tmp/wt-child-1',
    workspaceMode: 'worktree',
    toolNames: ['bash', 'read'],
    budget: {},
    model: { provider: 'acme', model: 'm1', thinking: 'high' },
    ...overrides,
  };
}

function spawnReq(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    task: validTask(),
    sessionId: 'child-1',
    systemPrompt: 'You implement.',
    scopedModels: [{ scope: 'spawn', provider: 'acme', model: 'm1' }],
    isGitWorktree: () => true,
    ...overrides,
  };
}

describe('spawn_agent contract (issue #41, §6.2 + §38.2 + §71)', () => {
  it('missing worktree fails the spawn, never a shared fallback', () => {
    const outcome = spawnAgent(
      spawnReq({ task: validTask({ worktree: '' }) }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SPAWN_FAILED');
      expect(outcome.reason).toMatch(/worktree/);
    }
    expect(outcome).not.toHaveProperty('spec');
    expect(outcome).not.toHaveProperty('handle');
  });

  it('non-git worktree fails the spawn with a reason', () => {
    const outcome = spawnAgent(
      spawnReq({ isGitWorktree: () => false }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SPAWN_FAILED');
      expect(outcome.reason).toMatch(/git/);
    }
  });

  it('success links the parent and assigns generation 1', () => {
    const outcome = spawnAgent(spawnReq(), createGenerationState());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec.parentSessionId).toBe('parent-1');
      expect(outcome.spec.sessionId).toBe('child-1');
      expect(outcome.spec.generation).toBe(1);
      expect(outcome.handle).toEqual({
        sessionId: 'child-1',
        generation: 1,
        worktreePath: '/tmp/wt-child-1',
      });
    }
  });

  it('generations are monotonic per session', () => {
    const generations = createGenerationState();
    const first = spawnAgent(spawnReq(), generations);
    const second = spawnAgent(spawnReq(), generations);
    if (first.ok && second.ok) {
      expect(first.spec.generation).toBe(1);
      expect(second.spec.generation).toBe(2);
    } else {
      expect.fail('both spawns should succeed');
    }
  });

  it('a stale generation send is rejected', () => {
    const generations = createGenerationState();
    const outcome = spawnAgent(spawnReq(), generations);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      spawnAgent(spawnReq(), generations);
      const stale = validateGenerationSend(generations, {
        sessionId: 'child-1',
        generation: 1,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toMatch(/stale/);
      const current = validateGenerationSend(generations, {
        sessionId: 'child-1',
        generation: 2,
      });
      expect(current.ok).toBe(true);
    }
  });

  it('a model outside the scoped set is rejected', () => {
    const outcome = spawnAgent(
      spawnReq({
        task: validTask({
          model: { provider: 'other', model: 'm9', thinking: 'low' },
        }),
      }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/scoped/);
  });

  it('an omitted budget succeeds with no budget key', () => {
    const { budget: _dropped, ...noBudget } = validTask();
    const outcome = spawnAgent(
      spawnReq({ task: noBudget as AgentTask }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec).not.toHaveProperty('budget');
    }
  });

  it('a configured budget travels on the spec', () => {
    const outcome = spawnAgent(
      spawnReq({ task: validTask({ budget: { maxTokens: 100 } }) }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.spec.budget).toEqual({ maxTokens: 100 });
    }
  });

  it('a non-object budget fails the spawn fail-closed (parity with validateTransferSpawn)', () => {
    const outcome = spawnAgent(
      spawnReq({
        task: validTask({ budget: 'x' as unknown as AgentTask['budget'] }),
      }),
      createGenerationState(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SPAWN_FAILED');
      expect(outcome.reason).toMatch(/budget/);
    }
    expect(outcome).not.toHaveProperty('spec');
  });

  it('allocation with __proto__/constructor keys stays monotonic (no prototype pollution)', () => {
    const generations = createGenerationState();
    expect(allocateGeneration(generations, '__proto__')).toBe(1);
    expect(allocateGeneration(generations, '__proto__')).toBe(2);
    expect(allocateGeneration(generations, 'constructor')).toBe(1);
    expect(allocateGeneration(generations, 'constructor')).toBe(2);
    expect(allocateGeneration(generations, 'child-1')).toBe(1);
    expect(
      validateGenerationSend(generations, {
        sessionId: '__proto__',
        generation: 2,
      }).ok,
    ).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });

  it('spawn deep-copies retryBudget so the child cannot mutate the parent task', () => {
    const task = validTask({
      budget: {
        maxTokens: 100,
        retryBudget: { maxAttempts: 3, maxCostUsd: 1 },
      },
    });
    const outcome = spawnAgent(spawnReq({ task }), createGenerationState());
    expect(outcome.ok).toBe(true);
    const childBudget = outcome.ok ? outcome.spec.budget : undefined;
    expect(childBudget?.retryBudget).toEqual({
      maxAttempts: 3,
      maxCostUsd: 1,
    });
    if (childBudget?.retryBudget !== undefined) {
      childBudget.retryBudget.maxAttempts = 99;
    }
    expect(task.budget.retryBudget).toEqual({
      maxAttempts: 3,
      maxCostUsd: 1,
    });
  });
});

function parentSnapshot(): SessionSnapshot {
  return {
    sessionId: 'parent-1',
    model: { provider: 'acme', model: 'm1', thinking: 'high' },
    systemPrompt: 'You implement.',
    resources: { skills: ['tdd'] },
    toolNames: ['bash', 'read'],
    budget: { maxTokens: 100 },
    worktreePath: '/tmp/wt-parent',
    transcript: [{ role: 'user', text: 'parent history' }],
    pendingCalls: [{ tool: 'bash', args: 'sleep 60' }],
  };
}

describe('fork semantics + child isolation (issue #41, §22.3 + §23 + §24)', () => {
  it('fork copies config and excludes in-flight state', () => {
    const config = forkSessionConfig(parentSnapshot());
    expect(config).toEqual({
      model: { provider: 'acme', model: 'm1', thinking: 'high' },
      systemPrompt: 'You implement.',
      resources: { skills: ['tdd'] },
      toolNames: ['bash', 'read'],
      budget: { maxTokens: 100 },
      worktreePath: '/tmp/wt-parent',
    });
    expect(config).not.toHaveProperty('transcript');
    expect(config).not.toHaveProperty('pendingCalls');
    expect(config).not.toHaveProperty('sessionId');
  });

  it('fork deep-copies so the child cannot mutate the parent', () => {
    const parent = parentSnapshot();
    const config = forkSessionConfig(parent);
    config.toolNames.push('write');
    expect(parent.toolNames).toEqual(['bash', 'read']);
  });

  it('fork deep-copies retryBudget so the child cannot mutate the parent', () => {
    const parent: SessionSnapshot = {
      ...parentSnapshot(),
      budget: {
        maxTokens: 100,
        retryBudget: { maxAttempts: 3, maxCostUsd: 1 },
      },
    };
    const config = forkSessionConfig(parent);
    expect(config.budget?.retryBudget).toEqual({
      maxAttempts: 3,
      maxCostUsd: 1,
    });
    if (config.budget?.retryBudget !== undefined) {
      config.budget.retryBudget.maxAttempts = 99;
    }
    expect(parent.budget?.retryBudget).toEqual({
      maxAttempts: 3,
      maxCostUsd: 1,
    });
  });

  it('fork rejects a non-object budget fail-closed (parity with spawnAgent)', () => {
    const parent: SessionSnapshot = {
      ...parentSnapshot(),
      budget: 'x' as unknown as SessionSnapshot['budget'],
    };
    expect(() => forkSessionConfig(parent)).toThrow(/budget/);
  });

  it('specKeyOf carries the (sessionId, generation) key', () => {
    expect(specKeyOf(validSpec())).toEqual({
      sessionId: 'child-1',
      generation: 1,
    });
  });

  it('child session starts independent with an empty transcript', () => {
    const parent = parentSnapshot();
    const first = openChildSession({ ...validSpec(), generation: 1 });
    const second = openChildSession({ ...validSpec(), generation: 1 });
    expect(first.transcript).toEqual([]);
    expect(first.transcript).not.toBe(second.transcript);
    expect(first.transcript).not.toBe(parent.transcript);
    expect(first.sessionId).toBe('child-1');
    expect(first.parentSessionId).toBe('parent-1');
    expect(first.worktreePath).toBe('/tmp/wt-child-1');
  });
});

describe('spawn-side result + provenance (issue #41, §68)', () => {
  it('a completed result always carries provenance', () => {
    const result = buildSubagentResult(validSpec(), 'completed', 'done');
    expect(result.provenance).toEqual({
      sessionId: 'child-1',
      generation: 1,
      parentSessionId: 'parent-1',
    });
    expect(validateSubagentResult(result).valid).toBe(true);
  });

  it('a failed result carries provenance and its error', () => {
    const result = buildSubagentResult(
      validSpec(),
      'failed',
      'tool blew up',
      'exit 1',
    );
    expect(result.provenance.sessionId).toBe('child-1');
    expect(result.error).toBe('exit 1');
    expect(validateSubagentResult(result).valid).toBe(true);
  });

  it('provenanceFor derives the key from the spec', () => {
    expect(provenanceFor(validSpec())).toEqual({
      sessionId: 'child-1',
      generation: 1,
      parentSessionId: 'parent-1',
    });
  });

  it('a result without provenance is rejected', () => {
    const { provenance: _dropped, ...noProvenance } = buildSubagentResult(
      validSpec(),
      'completed',
      'done',
    );
    const result = validateSubagentResult(noProvenance);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/provenance/);
  });

  it('a result carrying a transcript is rejected', () => {
    const result = validateSubagentResult({
      ...buildSubagentResult(validSpec(), 'completed', 'done'),
      transcript: [{ role: 'user', text: 'history' }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/transcript/);
  });

  it('a failed result without an error is rejected', () => {
    const result = validateSubagentResult(
      buildSubagentResult(validSpec(), 'failed', 'tool blew up'),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/error/);
  });
});
