// Per-turn spans on the TUI path (issue #290): a faux turn through a real
// TuiTurnRunner forwards run/tool events to TurnSpans and writes the settled
// turn's artifact. Stub lane only: zero network, zero paid tokens.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  TurnSpans,
  type TurnSpansSink,
} from '../../../packages/host/src/ops/perf/run-spans.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type {
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';
import { type TuiLaneLoop, TuiTurnRunner } from './tui-run.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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

// The prod sink shape: a per-turn tracker plus a writer appending to the
// session's spans.jsonl, backed by a real bridge over a scratch dir.
function fileSink(
  sessionId: string,
  written: string[],
): TurnSpansSink & { path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-turn-spans-'));
  made.push(dir);
  const bridge = createNodeFileBridge(dir);
  const path = join(sessionId, 'spans.jsonl');
  return {
    turns: new TurnSpans(sessionId),
    write: (artifact: string) => {
      bridge.appendFile(path, artifact);
      written.push(artifact);
    },
    path: join(dir, path),
  };
}

describe('TUI per-turn spans (issue #290)', () => {
  it('writes the settled turn with a tool span per tool call', async () => {
    const written: string[] = [];
    const sink = fileSink('sess-tui', written);
    const turn = new TuiTurnRunner(
      app(),
      stubLoop([
        { type: 'run-start', inputs: ['sub-1'] } as never,
        { type: 'tool-start', toolCallId: 'c1', toolName: 'read', args: {} },
        {
          type: 'tool-end',
          toolCallId: 'c1',
          toolName: 'read',
          isError: false,
        },
        { type: 'run-end', inputs: ['sub-1'] } as never,
      ]),
      'faux/faux-1',
      undefined,
      undefined,
      [],
      sink,
    );
    await turn.run('hi');
    expect(written).toHaveLength(1);
    const lines = readFileSync(sink.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; sessionId: string });
    expect(lines.map((span) => span.name)).toEqual([
      'kubic.agent.run',
      'pi.tool.execute',
    ]);
    for (const span of lines) expect(span.sessionId).toBe('sess-tui');
  });

  it('keeps a turn with no spans sink working exactly as before', async () => {
    const turn = new TuiTurnRunner(
      app(),
      stubLoop([
        { type: 'run-start', inputs: ['sub-1'] } as never,
        { type: 'run-end', inputs: ['sub-1'] } as never,
      ]),
      'faux/faux-1',
    );
    await expect(turn.run('hi')).resolves.toMatchObject({
      status: 'completed',
    });
  });
});
