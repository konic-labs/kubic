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
});
