import { describe, expect, it } from 'vitest';
import type { TaskTransfer } from './transfer.js';
import {
  buildTransferLog,
  grantRefFor,
  isBudgetConfigured,
  serializeTransfer,
  validateTransferSpawn,
} from './transfer.js';

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

  it('budget-absent spawn defaults to no limits', () => {
    const { budget: _dropped, ...noBudget } = validTransfer();
    const result = validateTransferSpawn(noBudget);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.transfer.budget).toEqual({});
  });

  it('isBudgetConfigured is false only for absent or empty budgets', () => {
    expect(isBudgetConfigured(undefined)).toBe(false);
    expect(isBudgetConfigured({})).toBe(false);
    expect(isBudgetConfigured({ maxTokens: 100 })).toBe(true);
  });

  it('serializeTransfer omits the budget key when nothing is configured', () => {
    const serialized = serializeTransfer(validTransfer({ budget: {} }));
    expect(serialized).not.toHaveProperty('budget');
  });

  it('serializeTransfer keeps the budget key when configured', () => {
    const serialized = serializeTransfer(
      validTransfer({ budget: { maxTokens: 100 } }),
    );
    expect(serialized).toHaveProperty('budget', { maxTokens: 100 });
  });

  it('rejects a spawn carrying the parent transcript', () => {
    const result = validateTransferSpawn({
      ...validTransfer(),
      transcript: [{ role: 'user', text: 'parent history' }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/transcript/);
  });

  it('rejects a worktree without its grant', () => {
    const { toolNames: _dropped, ...noGrant } = validTransfer();
    const result = validateTransferSpawn(noGrant);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/grant/);
  });

  it('sealed transfer carries only the transfer fields', () => {
    const result = validateTransferSpawn({
      ...validTransfer(),
      sideChannel: 'smuggled',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.transfer).not.toHaveProperty('sideChannel');
      expect(result.transfer).not.toHaveProperty('transcript');
    }
  });

  it('serialized transfer round-trips through JSON', () => {
    const serialized = serializeTransfer(
      validTransfer({ budget: { maxTokens: 100 } }),
    );
    const revived: unknown = JSON.parse(JSON.stringify(serialized));
    const result = validateTransferSpawn(revived);
    expect(result.valid).toBe(true);
  });

  it('grantRefFor derives a stable grant ref from the grant fields', () => {
    expect(grantRefFor(validTransfer())).toBe('worktree:bash,read');
  });

  it('buildTransferLog records task, worktree, and grant ref', () => {
    const log = buildTransferLog(validTransfer());
    expect(log).toEqual({
      kind: 'transfer',
      taskId: 'task-1',
      worktree: '/tmp/wt-1',
      grantRef: 'worktree:bash,read',
    });
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});
