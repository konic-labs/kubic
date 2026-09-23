// Effect/replay kernel (issue #12, slice C; §20.2).
// Tools declare `replay: "never" | "safe"`. A ToolCall runs:
//   planned → effect_pending (replay) → outcome_ready (terminate) → completed (terminate)
// EffectGate is the synchronous admission barrier: a hook or effect enters
// the gate and only admitted work proceeds — the ticket sequence makes "the
// operation was durably started" observable and ordered relative to hooks.
// tool_end carries an explicit terminate flag; the loop stops early only
// when EVERY finalized tool result in a batch terminates.

export const REPLAY_POLICIES = ['never', 'safe'] as const;
export type ReplayPolicy = (typeof REPLAY_POLICIES)[number];

export const TOOL_CALL_STATES = [
  'planned',
  'effect_pending',
  'outcome_ready',
  'completed',
] as const;
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

export interface ToolCall {
  id: string;
  replay: ReplayPolicy;
  state: ToolCallState;
}

export type ToolEvent =
  | { type: 'replay' }
  | { type: 'tool_end'; terminate: boolean };

export interface ToolEnd {
  toolCallId: string;
  terminate: boolean;
}

export function advanceToolCall(call: ToolCall, event: ToolEvent): ToolCall {
  if (call.state === 'completed') {
    throw new Error(
      `tool ${call.id} is completed (terminal) — no further events`,
    );
  }
  if (event.type === 'replay') {
    if (call.state !== 'planned') {
      throw new Error(
        `replay is only valid from planned (tool ${call.id} is ${call.state})`,
      );
    }
    if (call.replay === 'never') {
      throw new Error(
        `tool ${call.id} declares replay:"never" — admit once via the gate, never replay`,
      );
    }
    return { ...call, state: 'effect_pending' };
  }
  if (call.state === 'planned') {
    throw new Error(`tool ${call.id} is planned — replay before terminate`);
  }
  if (!event.terminate) return call;
  return {
    ...call,
    state: call.state === 'effect_pending' ? 'outcome_ready' : 'completed',
  };
}

export interface EffectTicket {
  label: string;
  seq: number;
}

export class EffectGate {
  private nextSeq = 1;
  private admitted = 0;

  admit(label: string): EffectTicket {
    const ticket: EffectTicket = { label, seq: this.nextSeq };
    this.nextSeq += 1;
    this.admitted += 1;
    return ticket;
  }

  admissions(): number {
    return this.admitted;
  }
}

export function batchTerminates(ends: ToolEnd[]): boolean {
  return ends.length > 0 && ends.every((e) => e.terminate);
}
