import { describe, expect, it } from 'vitest';
import type { AgentTask } from './task.js';
import {
  AGENT_TASK_FIELDS,
  buildAgentTask,
  validateAgentTask,
} from './task.js';

function validTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: 'task-1',
    parentSessionId: 'session-1',
    role: 'implementer',
    objective: 'Implement the widget',
    worktree: '/tmp/wt-1',
    workspaceMode: 'worktree',
    toolNames: ['bash', 'read'],
    budget: {},
    ...overrides,
  };
}

describe('agent task (issue #6, §67)', () => {
  it('field list matches §67 exactly', () => {
    expect(Object.keys(AGENT_TASK_FIELDS).sort()).toEqual([
      'artifacts',
      'budget',
      'constraints',
      'expectedOutput',
      'model',
      'objective',
      'parentSessionId',
      'previousFindings',
      'relevantFiles',
      'resources',
      'role',
      'scopedModels',
      'taskId',
      'toolNames',
      'workspaceMode',
      'worktree',
    ]);
    // Values are the closed-world marker: flipping any field to false must
    // fail (mutation: BooleanLiteral true→false).
    expect(AGENT_TASK_FIELDS).toEqual({
      taskId: true,
      parentSessionId: true,
      role: true,
      objective: true,
      worktree: true,
      constraints: true,
      relevantFiles: true,
      previousFindings: true,
      expectedOutput: true,
      model: true,
      scopedModels: true,
      workspaceMode: true,
      toolNames: true,
      budget: true,
      resources: true,
      artifacts: true,
    });
  });

  it('accepts a minimal valid task', () => {
    const result = validateAgentTask(validTask());
    expect(result.valid).toBe(true);
  });

  it('accepts a fully-populated task', () => {
    const result = validateAgentTask(
      validTask({
        constraints: ['no network'],
        relevantFiles: ['src/a.ts'],
        previousFindings: 'none',
        expectedOutput: 'a diff',
        model: { provider: 'acme', model: 'm1', thinking: 'high' },
        scopedModels: [{ scope: 'review', provider: 'acme', model: 'm2' }],
        resources: { skills: ['tdd'], promptTemplates: ['impl'] },
        artifacts: [{ artifactId: 'a1' }],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a relative worktree', () => {
    const result = validateAgentTask(validTask({ worktree: 'relative/path' }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/worktree/);
  });

  it('rejects an empty objective', () => {
    const result = validateAgentTask(validTask({ objective: '  ' }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/objective/);
  });

  it('rejects empty toolNames', () => {
    const result = validateAgentTask(validTask({ toolNames: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/toolNames/);
  });

  it('rejects a missing budget', () => {
    const { budget: _dropped, ...noBudget } = validTask();
    const result = validateAgentTask(noBudget);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/budget/);
  });

  it('rejects a workspaceMode outside the closed union', () => {
    const result = validateAgentTask(
      validTask({ workspaceMode: 'remote' as never }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/workspaceMode/);
  });

  it('JSON round-trip preserves validity and shape', () => {
    const task = validTask({ workspaceMode: 'shared', toolNames: ['grep'] });
    const revived: unknown = JSON.parse(JSON.stringify(task));
    const result = validateAgentTask(revived);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.task).toEqual(task);
  });
});

// §67 (issue #191): the manager builds the task it hands a worker, and the
// capability grant travels with it — an invalid task is a named refusal
// BEFORE any process exists.
describe('buildAgentTask (issue #191)', () => {
  const input = {
    taskId: 'sess-1:alpha',
    parentSessionId: 'sess-1',
    role: 'implementer',
    objective: 'Plan step 1 of 1: ship it',
    worktree: '/repo/.kubic/wt/sess-1/alpha',
    toolNames: ['read', 'write'],
  };

  it('builds a worktree task that validates', () => {
    const built = buildAgentTask(input);
    expect(built.valid).toBe(true);
    if (built.valid) {
      expect(built.task).toMatchObject({
        taskId: 'sess-1:alpha',
        parentSessionId: 'sess-1',
        role: 'implementer',
        worktree: '/repo/.kubic/wt/sess-1/alpha',
        workspaceMode: 'worktree',
        toolNames: ['read', 'write'],
        budget: {},
      });
    }
  });

  it('refuses a relative worktree or an empty tool set by name', () => {
    const relative = buildAgentTask({ ...input, worktree: '.kubic/wt/x' });
    expect(relative.valid).toBe(false);
    if (!relative.valid) {
      expect(relative.errors.join('; ')).toMatch(
        /worktree must be an absolute path/,
      );
    }
    const empty = buildAgentTask({ ...input, toolNames: [] });
    expect(empty.valid).toBe(false);
    if (!empty.valid) {
      expect(empty.errors.join('; ')).toMatch(/toolNames must be a non-empty/);
    }
  });

  it('carries the optional levels it was given', () => {
    const built = buildAgentTask({
      ...input,
      budget: { maxToolCalls: 5 },
      constraints: ['do not touch main'],
      expectedOutput: 'a diff',
      model: { provider: 'acme', model: 'm1' },
    });
    expect(built.valid).toBe(true);
    if (built.valid) {
      expect(built.task.budget).toEqual({ maxToolCalls: 5 });
      expect(built.task.constraints).toEqual(['do not touch main']);
      expect(built.task.expectedOutput).toBe('a diff');
      expect(built.task.model).toEqual({ provider: 'acme', model: 'm1' });
    }
  });
});
