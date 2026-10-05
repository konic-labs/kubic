// The queued follow-up rows are rendered from the replicated state (issue
// #333 review): the app writes `lane.queued` on EVERY presentation apply, so
// a state that resolved the inbox only at its own `inbox` event wiped the row
// on the next lane event (a tool end, a delta) and left it gone for the rest
// of the turn. Stub lane only: zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type {
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import { type TuiLaneLoop, TuiTurnRunner } from './tui-run.js';

function app() {
  return createTuiApp({
    sessionId: 's',
    model: 'faux/faux-1',
    mode: 'solo',
    approvalsSkipped: false,
  });
}

// A lane whose one turn emits `events` through the subscription's sink.
function stubLoop(events: readonly KubicLaneEvent[]): TuiLaneLoop {
  return {
    context: BACKGROUND_CONTEXT,
    subscribe: async (sink: LaneEventSink) => {
      sink({
        type: 'snapshot',
        entries: [],
        tools: [],
        compactions: [],
        usage: { models: {}, tools: {} },
      });
      for (const event of events) sink(event);
      return async () => {};
    },
    runTurn: async () => ({ kind: 'completed' }),
    entries: async () => [],
    forgetKills: () => {},
  } as unknown as TuiLaneLoop;
}

function runner(
  target: ReturnType<typeof app>,
  events: readonly KubicLaneEvent[],
) {
  const queuedText = new Map([['sub-1', 'second prompt']]);
  const turn = new TuiTurnRunner(target, stubLoop(events), 'faux/faux-1');
  turn.setQueuedText(queuedText);
  return { turn, queuedText };
}

describe('queued follow-up rows from the state (issue #333 review)', () => {
  it('keeps the row across later lane events', async () => {
    const target = app();
    const { turn } = runner(target, [
      { type: 'inbox', items: [{ id: 'sub-1', mode: 'followUp' }] } as never,
      { type: 'tool-start', toolCallId: 'c1', toolName: 'read', args: {} },
      { type: 'tool-end', toolCallId: 'c1', toolName: 'read', isError: false },
    ]);
    await turn.run('hi');
    // The queue is still the harness's (nothing placed it): the row survives
    // every event after the `inbox` snapshot.
    expect(target.render(100).join('\n')).toContain('queued: second prompt');
  });

  it('drops the row in the very frame the placement lands in', async () => {
    // The loop's own `run-start` bookkeeping (bootTuiLane's branch): the
    // harness placed the submission, so its id leaves the map and the prompt
    // becomes the pending echo. The state resolves against that map, and the
    // sink runs the loop's bookkeeping BEFORE the fold — flip that order and
    // this frame keeps a row the placement already consumed.
    const target = app();
    const queuedText = new Map([['sub-1', 'second prompt']]);
    const turn = new TuiTurnRunner(
      target,
      stubLoop([
        { type: 'inbox', items: [{ id: 'sub-1', mode: 'followUp' }] } as never,
        { type: 'run-start', inputs: ['sub-1'] } as never,
      ]),
      'faux/faux-1',
      undefined,
      (event) => {
        if (event.type !== 'run-start') return;
        for (const input of event.inputs) {
          const id = String(input);
          const text = queuedText.get(id);
          if (text === undefined) continue;
          queuedText.delete(id);
          target.setPendingEcho(text);
        }
      },
    );
    turn.setQueuedText(queuedText);
    await turn.run('hi');
    const doc = target.render(100).join('\n');
    expect(doc).not.toContain('queued: second prompt');
    // The placed submission is the pending echo instead.
    expect(doc).toContain('second prompt');
  });
});
