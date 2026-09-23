// §61 lifecycle perf budgets (issue #42): spawn<200ms warm,
// teardown<1s non-blocking, attach<50ms, worktree<300ms. Pure
// threshold checks — the CI gate calls these, never wall-clock sleeps.
import { describe, expect, it } from 'vitest';
import {
  checkPerfGate,
  LIFECYCLE_BUDGETS_MS,
  type PerfSample,
} from './budgets.js';

const warmFast: PerfSample = {
  spawnMs: 12,
  startupMs: 40,
  attachMs: 5,
  teardownInitiateMs: 1,
  teardownSettledMs: 30,
};

describe('lifecycle perf gate §61 (issue #42)', () => {
  it('pins the §61 budget values', () => {
    expect(LIFECYCLE_BUDGETS_MS).toEqual({
      worktreeMs: 300,
      spawnMs: 200,
      attachMs: 50,
      teardownMs: 1000,
    });
  });

  it('passes a warm fast lifecycle', () => {
    expect(checkPerfGate(warmFast)).toEqual({ ok: true, breaches: [] });
  });

  it('fails a slow spawn over 200ms warm', () => {
    const out = checkPerfGate({ ...warmFast, spawnMs: 250 });
    expect(out.ok).toBe(false);
    expect(out.breaches.join(' ')).toMatch(/spawn/);
  });

  it('fails a blocking teardown that settles past 1s', () => {
    const out = checkPerfGate({ ...warmFast, teardownSettledMs: 1_500 });
    expect(out.ok).toBe(false);
    expect(out.breaches.join(' ')).toMatch(/teardown/);
  });

  it('admits each sample exactly at its budget — over by 1 breaches (issue #70)', () => {
    const atBudget: PerfSample = {
      spawnMs: 200,
      attachMs: 50,
      worktreeMs: 300,
      teardownInitiateMs: 1,
      teardownSettledMs: 1000,
    };
    expect(checkPerfGate(atBudget)).toEqual({ ok: true, breaches: [] });
    expect(
      checkPerfGate({ ...atBudget, spawnMs: 201 }).breaches.join(' '),
    ).toMatch(/spawn/);
    expect(
      checkPerfGate({ ...atBudget, attachMs: 51 }).breaches.join(' '),
    ).toMatch(/attach/);
    expect(
      checkPerfGate({ ...atBudget, worktreeMs: 301 }).breaches.join(' '),
    ).toMatch(/worktree/);
    expect(
      checkPerfGate({ ...atBudget, teardownSettledMs: 1001 }).breaches.join(
        ' ',
      ),
    ).toMatch(/teardown/);
  });

  it('skips attach/worktree gates when unmeasured, collects every breach (issue #70)', () => {
    const unmeasured: PerfSample = {
      spawnMs: 12,
      teardownInitiateMs: 1,
      teardownSettledMs: 30,
    };
    expect(checkPerfGate(unmeasured)).toEqual({ ok: true, breaches: [] });
    const both = checkPerfGate({
      ...unmeasured,
      spawnMs: 250,
      teardownSettledMs: 1500,
    });
    expect(both.ok).toBe(false);
    expect(both.breaches).toHaveLength(2);
    expect(both.breaches.join(' ')).toMatch(/spawn/);
    expect(both.breaches.join(' ')).toMatch(/teardown/);
  });
});
