// The single automatic escalation trigger: N
// consecutive tool-failure turns climb the lane one rung — once per run,
// never back. Pure state machine plus the row formatter; the boots own
// the climb itself. Faux only, no lanes, no I/O.
import { describe, expect, it } from 'vitest';
import {
  AUTO_ESCALATION_TOOL_FAILURES,
  createAutoEscalation,
  formatEscalationRow,
  markAutoEscalated,
  nextLadderRung,
  noteAutoEscalationTurn,
  resetAutoEscalation,
  shouldAutoEscalate,
  toTrajectoryEscalation,
} from './auto-escalation.js';

describe('automatic escalation trigger', () => {
  it('fires after N consecutive tool failures, exactly once', () => {
    const state = createAutoEscalation();
    expect(shouldAutoEscalate(state)).toBe(false);
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_timeout');
    expect(shouldAutoEscalate(state)).toBe(false);
    noteAutoEscalationTurn(state, 'tool_unavailable');
    expect(shouldAutoEscalate(state)).toBe(true);
    markAutoEscalated(state);
    // The single auto climb is spent: further failures never re-fire.
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    expect(shouldAutoEscalate(state)).toBe(false);
  });

  it('resets the streak on any non-tool settlement', () => {
    const state = createAutoEscalation();
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    // A completed turn breaks the streak — the tools work again.
    noteAutoEscalationTurn(state, undefined);
    noteAutoEscalationTurn(state, 'tool_failed');
    expect(shouldAutoEscalate(state)).toBe(false);
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    expect(shouldAutoEscalate(state)).toBe(true);
  });

  it('ignores non-execution failures (bad args are the model to fix)', () => {
    const state = createAutoEscalation();
    // tool_invalid_args is the model's own defect — retryable by
    // correction, never a reason to switch models.
    noteAutoEscalationTurn(state, 'tool_invalid_args');
    noteAutoEscalationTurn(state, 'model_failed');
    noteAutoEscalationTurn(state, 'provider_transient');
    expect(shouldAutoEscalate(state)).toBe(false);
  });

  it('an explicit climb restarts the streak without spending the auto slot', () => {
    const state = createAutoEscalation();
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    // The operator climbed by hand: the old streak dies with the old
    // model, but the single auto climb is still available.
    resetAutoEscalation(state);
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    noteAutoEscalationTurn(state, 'tool_failed');
    expect(shouldAutoEscalate(state)).toBe(true);
  });

  it('the threshold names itself', () => {
    expect(AUTO_ESCALATION_TOOL_FAILURES).toBe(3);
  });
});

describe('ladder rung stepping', () => {
  const steps = ['local/a', 'local/b', 'anthropic/x'];
  it('steps one rung up from the live model', () => {
    expect(nextLadderRung(steps, 'local/a')).toBe('local/b');
    expect(nextLadderRung(steps, 'local/b')).toBe('anthropic/x');
  });
  it('stops at the top and off the ladder', () => {
    expect(nextLadderRung(steps, 'anthropic/x')).toBeUndefined();
    expect(nextLadderRung(steps, 'other/z')).toBeUndefined();
  });
});

describe('escalation reporting', () => {
  it('formats the transcript row from the recorded event', () => {
    expect(
      formatEscalationRow({
        from: 'local/a',
        to: 'local/b',
        reason: '3 consecutive tool failures',
      }),
    ).toBe('escalation: local/a → local/b (3 consecutive tool failures)');
  });

  it('maps the lane event onto the trajectory schema', () => {
    expect(
      toTrajectoryEscalation(
        {
          reason: '3 consecutive tool failures',
          at: 1728000000000,
          from: 'local/a',
          to: 'local/b',
        },
        null,
      ),
    ).toEqual({
      reason: '3 consecutive tool failures',
      at: new Date(1728000000000).toISOString(),
      fromModel: 'local/a',
      toModel: 'local/b',
      thinking: null,
    });
  });
});
