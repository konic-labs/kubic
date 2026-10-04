// Live streaming of assistant text through the lane watch (issue #296; §61,
// §15.2). The lane maps pi-durable's `message_update` text deltas into
// `message-delta` events; the runner renders them as a draft and the
// committed entry replaces it. The transcript is read once per turn, never
// per event. Stub lane only: zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type {
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import {
  BACKGROUND_CONTEXT,
  type EntryRecord,
} from '../../../packages/worker/src/pi-boundary.js';
import { type TuiLaneLoop, TuiTurnRunner } from './tui-run.js';

const COMMITTED: EntryRecord = {
  id: 7,
  conversationId: 1,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      provider: 'faux',
      model: 'faux-1',
      content: [{ type: 'text', text: 'Hello world' }],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 13,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ],
} as unknown as EntryRecord;

const ROW = {
  model: 'faux-1',
  provider: 'faux',
  entryId: '7',
  usage: {
    input: 10,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

function app() {
  return createTuiApp({
    sessionId: 's',
    model: 'faux/faux-1',
    mode: 'solo',
    approvalsSkipped: false,
  });
}

// A lane whose one turn emits `events` through the subscription's sink.
function stubLoop(
  events: readonly KubicLaneEvent[],
  counters: { entries: number },
): TuiLaneLoop {
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
    entries: async () => {
      counters.entries += 1;
      return [COMMITTED];
    },
    forgetKills: () => {},
  } as unknown as TuiLaneLoop;
}

describe('live assistant streaming (issue #296)', () => {
  it('renders partial text before the message commits, then the entry once', async () => {
    const frames: string[] = [];
    const target = app();
    const runner = new TuiTurnRunner(
      target,
      stubLoop(
        [
          { type: 'message-delta', text: 'Hel' },
          { type: 'message-delta', text: 'lo ' },
          { type: 'message-delta', text: 'world' },
          { type: 'usage', row: ROW, entry: COMMITTED },
        ],
        { entries: 0 },
      ),
      'faux/faux-1',
      () => frames.push(target.render(100).join('\n')),
    );
    const outcome = await runner.run('hi');
    expect(outcome.status).toBe('completed');
    // At least two mid-stream render states, and the FIRST one already
    // carried partial text (the opposite of "only after the commit").
    const partial = frames.filter((frame) => frame.includes('Hel'));
    expect(partial.length).toBeGreaterThanOrEqual(2);
    expect(partial[0]).toContain('Hel');
    expect(partial.some((frame) => frame.includes('Hello world'))).toBe(true);
    // The committed entry replaces the draft: the text appears exactly once.
    const final = target.render(100).join('\n');
    expect(final.match(/Hello world/g)).toHaveLength(1);
  });

  it('clears a draft the turn never commits (an abort mid-stream)', async () => {
    const target = app();
    const runner = new TuiTurnRunner(
      target,
      stubLoop([{ type: 'message-delta', text: 'half an ans' }], {
        entries: 0,
      }),
      'faux/faux-1',
    );
    await runner.run('hi');
    // The settlement clears it: no stale draft survives the turn.
    expect(target.render(100).join('\n')).not.toContain('half an ans');
  });

  it('drops a stale draft when a rebase snapshot arrives', async () => {
    const target = app();
    const runner = new TuiTurnRunner(
      target,
      stubLoop(
        [
          { type: 'message-delta', text: 'stale' },
          {
            type: 'snapshot',
            entries: [COMMITTED],
            tools: [],
            compactions: [],
            usage: { models: {}, tools: {} },
          },
        ],
        { entries: 0 },
      ),
      'faux/faux-1',
    );
    await runner.run('hi');
    const final = target.render(100).join('\n');
    expect(final).not.toContain('stale');
    expect(final).toContain('Hello world');
  });

  it('reads the transcript once per turn, not once per event', async () => {
    const counters = { entries: 0 };
    const events: KubicLaneEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      events.push({ type: 'message-delta', text: `chunk ${i} ` });
    }
    events.push({ type: 'usage', row: ROW, entry: COMMITTED });
    const runner = new TuiTurnRunner(
      app(),
      stubLoop(events, counters),
      'faux/faux-1',
    );
    await runner.run('hi');
    // The settle read is the turn's ONE transcript read (the snapshot and
    // the committed events carry their own entries).
    expect(counters.entries).toBe(1);
  });
});
