// (7) escalation discipline: one-way recorded, cheap-3x-fail loses (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import {
  compareEscalationValue,
  createCostLadder,
  escalateCost,
  requiresFreshSessionForDeescalation,
} from './escalation.js';

describe('escalation discipline (issue #56)', () => {
  it('escalates one way with a recorded reason', () => {
    const ladder = createCostLadder(['cheap', 'mid', 'expensive']);
    const step = escalateCost(ladder, 'cheap', 'mid', 'stuck on tests');
    expect(step.to).toBe('mid');
    expect(ladder.record).toHaveLength(1);
    expect(ladder.record[0]?.reason).toBe('stuck on tests');
  });

  it('refuses de-escalation: a cheaper model needs a new agent/session', () => {
    const ladder = createCostLadder(['cheap', 'mid']);
    expect(() => escalateCost(ladder, 'mid', 'cheap', 'save money')).toThrow(
      /one-way/,
    );
    expect(requiresFreshSessionForDeescalation()).toBe(true);
  });

  it('cheap-3x-fail loses to expensive-1x-win', () => {
    expect(
      compareEscalationValue({
        cheapFails: 3,
        cheapCost: 0.03,
        expensiveWinCost: 0.1,
      }),
    ).toBe('escalate');
    expect(
      compareEscalationValue({
        cheapFails: 1,
        cheapCost: 0.01,
        expensiveWinCost: 0.1,
      }),
    ).toBe('stay');
  });
});
