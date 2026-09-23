// Perf budgets RED slice 1 (issue #55; §61): explicit ms constants +
// p50/p95 CI gates with regression filing. Fails until budgets.js lands.
import { describe, expect, it } from 'vitest';
import {
  ATTACH_BUDGET_MS,
  evaluateBudget,
  isNextSpawnUnblocked,
  isWithinBudget,
  SPAWN_BUDGET_MS,
  TEARDOWN_BUDGET_MS,
  WORKTREE_BUDGET_MS,
} from './budgets.js';

describe('perf budget constants (§61)', () => {
  it('pins worktree<300ms, spawn<200ms, attach<50ms, teardown<1s', () => {
    expect(WORKTREE_BUDGET_MS).toBe(300);
    expect(SPAWN_BUDGET_MS).toBe(200);
    expect(ATTACH_BUDGET_MS).toBe(50);
    expect(TEARDOWN_BUDGET_MS).toBe(1000);
  });

  it('admits elapsed under budget, rejects elapsed at/over budget', () => {
    expect(isWithinBudget('spawn', 199)).toBe(true);
    expect(isWithinBudget('spawn', 200)).toBe(false);
    expect(isWithinBudget('attach', 50)).toBe(false);
  });
});

describe('p50/p95 gates with regression filing', () => {
  it('passes when p95 fits the budget', () => {
    const result = evaluateBudget('attach', [5, 10, 12, 20, 40]);
    expect(result.p95).toBeLessThanOrEqual(ATTACH_BUDGET_MS);
    expect(result.within).toBe(true);
    expect(result.regression).toBeNull();
  });

  it('files a regression naming kind, p95, and budget when p95 blows it', () => {
    const result = evaluateBudget('spawn', [10, 20, 30, 40, 500]);
    expect(result.within).toBe(false);
    expect(result.regression).toMatch(/spawn/);
    expect(result.regression).toMatch(/500/);
    expect(result.regression).toMatch(/200/);
  });

  it('never lets N teardowns delay the next spawn past attach budget', () => {
    expect(isNextSpawnUnblocked([800, 900, 950], 40)).toBe(true);
    expect(isNextSpawnUnblocked([800, 1200, 950], 40)).toBe(false);
    expect(isNextSpawnUnblocked([800, 900, 950], 60)).toBe(false);
  });
});
