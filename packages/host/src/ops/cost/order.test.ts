// §62 strict 8-lever order (issue #56): RED first — order.ts lands next.
import { describe, expect, it } from 'vitest';
import { assertLeverOrder, COST_LEVERS, nextRequiredLever } from './order.js';

describe('§62 lever order (issue #56)', () => {
  it('fixes the 8 levers in §62 order', () => {
    expect([...COST_LEVERS]).toEqual([
      'role-model',
      'cache-preservation',
      'compact-reuse',
      'spawn-gate',
      'retry-discipline',
      'output-limits',
      'escalation',
      'exact-cache',
    ]);
  });

  it('accepts the full in-order application', () => {
    expect(assertLeverOrder([...COST_LEVERS]).ok).toBe(true);
  });

  it('rejects skipping: cache before per-role is review-blocking', () => {
    const verdict = assertLeverOrder(['cache-preservation', 'role-model']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reviewBlocking).toBe(true);
      expect(verdict.reason).toMatch(/order/);
    }
    expect(nextRequiredLever([])).toBe('role-model');
  });

  it('requires each earlier lever before a later one', () => {
    const verdict = assertLeverOrder(['role-model', 'spawn-gate']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.missing).toContain('cache-preservation');
  });
});
