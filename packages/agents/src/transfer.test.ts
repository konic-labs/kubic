import { describe, expect, it } from 'vitest';
import type { TaskTransfer } from './transfer.js';
import { validateTransferSpawn } from './transfer.js';

function validTransfer(overrides: Partial<TaskTransfer> = {}): TaskTransfer {
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

describe('transfer boundedness (issue #31, §24)', () => {
  it('accepts a valid transfer with worktree and grant together', () => {
    const result = validateTransferSpawn(validTransfer());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.transfer.taskId).toBe('task-1');
  });

  it('rejects a transfer missing a required field', () => {
    const { objective: _dropped, ...noObjective } = validTransfer();
    const result = validateTransferSpawn(noObjective);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/objective/);
  });
});
