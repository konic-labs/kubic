import { describe, expect, it } from 'vitest';
import type { ToolCall, ToolEnd, ToolEvent } from './effects.js';
import {
  advanceToolCall,
  batchTerminates,
  EffectGate,
  REPLAY_POLICIES,
} from './effects.js';

function planned(replay: 'never' | 'safe' = 'safe'): ToolCall {
  return { id: 'tc1', replay, state: 'planned' };
}

const replay: ToolEvent = { type: 'replay' };
const end = (terminate: boolean): ToolEvent => ({
  type: 'tool_end',
  terminate,
});

describe('toolCall machine + EffectGate + batch termination (issue #12, slice C)', () => {
  it('declares the exact replay policies', () => {
    expect([...REPLAY_POLICIES]).toEqual(['never', 'safe']);
  });

  it('runs the golden path planned → effect_pending → outcome_ready → completed', () => {
    let call = planned();
    call = advanceToolCall(call, replay);
    expect(call.state).toBe('effect_pending');
    call = advanceToolCall(call, end(true));
    expect(call.state).toBe('outcome_ready');
    call = advanceToolCall(call, end(true));
    expect(call.state).toBe('completed');
  });

  it('replays under the same invocation id (safe reuse, never remint)', () => {
    const first = advanceToolCall(planned(), replay);
    expect(first.id).toBe('tc1');
    expect(advanceToolCall(first, end(true)).id).toBe('tc1');
  });

  it('refuses to replay a never-replay effect', () => {
    expect(() => advanceToolCall(planned('never'), replay)).toThrow(
      /never.*replay|replay.*never/i,
    );
  });

  it('holds at effect_pending while tool_end.terminate is false', () => {
    const call = advanceToolCall(planned(), replay);
    const held = advanceToolCall(call, end(false));
    expect(held.state).toBe('effect_pending');
    expect(held).not.toBe(call);
  });

  it('rejects terminate from planned and any event on completed', () => {
    expect(() => advanceToolCall(planned(), end(true))).toThrow(/planned/i);
    const done: ToolCall = { id: 'tc1', replay: 'safe', state: 'completed' };
    expect(() => advanceToolCall(done, replay)).toThrow(/completed|terminal/i);
    expect(() => advanceToolCall(done, end(true))).toThrow(
      /completed|terminal/i,
    );
  });

  it('admits effects with strictly increasing sequence numbers', () => {
    const gate = new EffectGate();
    const a = gate.admit('hook:pre-tool');
    const b = gate.admit('tool:bash');
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(gate.admissions()).toBe(2);
  });

  it('stops the loop only when every finalized result terminates', () => {
    const all: ToolEnd[] = [
      { toolCallId: 'a', terminate: true },
      { toolCallId: 'b', terminate: true },
    ];
    expect(batchTerminates(all)).toBe(true);
    expect(
      batchTerminates([...all, { toolCallId: 'c', terminate: false }]),
    ).toBe(false);
    expect(batchTerminates([])).toBe(false);
  });
});
