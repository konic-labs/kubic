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

  it('freezes the ladder: hostile reorder cannot fake de-escalation', () => {
    const ladder = createCostLadder(['cheap', 'mid', 'expensive']);
    expect(Object.isFrozen(ladder.steps)).toBe(true);
    expect(Object.isFrozen(ladder.record)).toBe(true);
    const before = [...ladder.steps];
    try {
      (ladder.steps as unknown as string[]).splice(
        0,
        3,
        'expensive',
        'mid',
        'cheap',
      );
    } catch {
      // Frozen: strict-mode mutation throws. Either way the ladder must not change.
    }
    expect([...ladder.steps]).toEqual(before);
    expect(() => escalateCost(ladder, 'mid', 'cheap', 'save money')).toThrow(
      /one-way/,
    );
  });

  it('keeps the escalation record frozen across escalations', () => {
    const ladder = createCostLadder(['cheap', 'mid']);
    escalateCost(ladder, 'cheap', 'mid', 'stuck on tests');
    expect(ladder.record).toHaveLength(1);
    expect(Object.isFrozen(ladder.record)).toBe(true);
  });

  it('escalates on 3 cheap fails even when the burn is below the expensive win', () => {
    expect(
      compareEscalationValue({
        cheapFails: 3,
        cheapCost: 0.01,
        expensiveWinCost: 10,
      }),
    ).toBe('escalate');
  });

  it('stays below 3 fails when the burn is below the expensive win', () => {
    expect(
      compareEscalationValue({
        cheapFails: 2,
        cheapCost: 0.01,
        expensiveWinCost: 10,
      }),
    ).toBe('stay');
  });
});
