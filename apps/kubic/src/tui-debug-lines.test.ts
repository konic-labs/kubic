// Handler_error + [model] lines on the TUI path: a lane
// fault reaches the runner's debug sink (when attached) and always a
// transcript notice — the TUI has no --debug channel — and each committed
// response's token counts reach the sink as the [model] line. Stub lane
// only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type {
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { bootTuiLane, type TuiLaneLoop, TuiTurnRunner } from './tui-run.js';

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
    approvalsSkipped: false,
  });
}

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
    entries: async () => [COMMITTED],
    forgetKills: () => {},
  } as unknown as TuiLaneLoop;
}

describe('TUI debug lines', () => {
  it('routes a lane fault to the debug sink and a transcript notice', async () => {
    const target = app();
    const notice = vi.spyOn(target, 'appendNotice');
    const debugLines: string[] = [];
    const runner = new TuiTurnRunner(
      target,
      stubLoop([{ type: 'fault', code: 'tool', message: 'task exploded' }]),
      'faux/faux-1',
      undefined,
      undefined,
      [],
      undefined,
      (line: string) => debugLines.push(line),
    );
    await runner.run('hi');
    // Pi 1.0 has no handler_error event: the lane fault IS the debug line.
    expect(debugLines).toEqual([
      'handler_error hook=tool error=task exploded verdict=deny',
    ]);
    expect(notice).toHaveBeenCalledWith([
      'handler_error hook=tool error=task exploded verdict=deny',
    ]);
  });

  it('routes a committed response to the [model] token line', async () => {
    const debugLines: string[] = [];
    const runner = new TuiTurnRunner(
      app(),
      stubLoop([{ type: 'usage', row: ROW, entry: COMMITTED }]),
      'faux/faux-1',
      undefined,
      undefined,
      [],
      undefined,
      (line: string) => debugLines.push(line),
    );
    await runner.run('hi');
    expect(debugLines).toEqual(['[model] in=10 out=3 cached=0 faux/faux-1']);
  });

  it('still notices a fault with no debug sink attached', async () => {
    const target = app();
    const notice = vi.spyOn(target, 'appendNotice');
    const runner = new TuiTurnRunner(
      target,
      stubLoop([{ type: 'fault', code: 'tool', message: 'task exploded' }]),
      'faux/faux-1',
    );
    await expect(runner.run('hi')).resolves.toMatchObject({
      status: 'completed',
    });
    expect(notice).toHaveBeenCalledWith([
      'handler_error hook=tool error=task exploded verdict=deny',
    ]);
  });
});

describe('TUI boot debug lines', () => {
  const made: string[] = [];

  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', undefined);
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fauxModels(): ReturnType<typeof createModels> {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('ok')]);
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  it('emits the [session] and default [policy] lines to the injected sink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-debug-'));
    made.push(dir);
    const debugLines: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: dir,
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
      debug: (line: string) => debugLines.push(line),
    });
    try {
      // The stock boot names its session and runs as solo.
      expect(debugLines.some((line) => line.startsWith('[session] id='))).toBe(
        true,
      );
      expect(debugLines).toContain('[policy] role=solo (default)');
      // The runner is threaded the same sink for its fault/token lines.
      expect(boot.debug).toBeDefined();
    } finally {
      await boot.close?.();
    }
  });
});
