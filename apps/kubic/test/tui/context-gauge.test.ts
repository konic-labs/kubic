// The context gauge's production wiring: the boot hands
// the status bar the running model's context window and the compaction
// threshold derived from it, a `/model` switch moves both, and the reading
// follows every commit (a tool result moves it mid-turn) and survives a
// resume. Faux provider only: zero network, zero paid tokens.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from '@kubic/agent/compaction';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  ToolResultEntry,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { createTuiApp } from '@kubic/tui/tui-app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import { ContextMeter } from '../../src/tui/context-meter.js';
import { contextLimitsOf } from '../../src/tui/lane-loop.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';
import { TuiTurnRunner } from '../../src/tui/turn-runner.js';
import type { TuiLaneBoot, TuiLaneLoop } from '../../src/tui/types.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function fauxModels(): ReturnType<typeof createModels> {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('ok')]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe('context gauge wiring', () => {
  it('derives the window and the compaction threshold from the catalog', () => {
    const models = fauxModels();
    const limits = contextLimitsOf(models, 'faux', 'faux-1');
    expect(limits.contextWindow).toBe(128000);
    expect(limits.compactionThreshold).toBe(
      128000 - effectiveReserveTokens(128000, DEFAULT_RESERVE_TOKENS),
    );
    // An unknown model (or provider) yields no limits: no made-up gauge.
    expect(contextLimitsOf(models, 'faux', 'nope')).toEqual({});
    expect(contextLimitsOf(models, 'nope', 'nope')).toEqual({});
  });

  it('hands the running model limits to the boot', async () => {
    const root = tempDir('kubic-tui-context-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: root,
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.contextLimits?.contextWindow).toBe(128000);
      expect(boot.contextLimits?.compactionThreshold).toBe(
        128000 - effectiveReserveTokens(128000, DEFAULT_RESERVE_TOKENS),
      );
    } finally {
      await boot.close?.();
    }
  });

  it('moves the gauge on a /model switch through the loop lookup', async () => {
    const app = createTuiApp({
      sessionId: 's1',
      model: 'a/small',
      approvalsSkipped: false,
      contextWindow: 1000,
      compactionThreshold: 500,
    });
    const loop = {
      context: undefined,
      switchModel: async (): Promise<string> => 'b/big',
      contextLimits: (): {
        contextWindow: number;
        compactionThreshold: number;
      } => ({
        contextWindow: 8000,
        compactionThreshold: 7000,
      }),
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(app, loop, 'a/small');
    expect(await runner.switchModel({ provider: 'b', id: 'big' })).toBe(
      'b/big',
    );
    expect(app.status.getState().contextWindow).toBe(8000);
    expect(app.status.getState().compactionThreshold).toBe(7000);
  });

  it('leaves the seeded limits alone when the loop has no lookup', async () => {
    const app = createTuiApp({
      sessionId: 's1',
      model: 'a/small',
      approvalsSkipped: false,
      contextWindow: 1000,
      compactionThreshold: 500,
    });
    const loop = {
      context: undefined,
      switchModel: async (): Promise<string> => 'b/big',
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(app, loop, 'a/small');
    await runner.switchModel({ provider: 'b', id: 'big' });
    expect(app.status.getState().contextWindow).toBe(1000);
  });
});

describe('the context meter', () => {
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it('folds the requests that land during a read into one more read', async () => {
    const pending: Array<(tokens: number) => void> = [];
    const applied: number[] = [];
    const meter = new ContextMeter({
      read: () => new Promise((resolve) => pending.push(resolve)),
      apply: (tokens) => applied.push(tokens),
    });
    void meter.request();
    void meter.request();
    const last = meter.request();
    expect(pending).toHaveLength(1);
    pending[0]?.(100);
    await settle();
    // The two requests that arrived mid-read cost exactly one more read.
    expect(pending).toHaveLength(2);
    pending[1]?.(250);
    await last;
    expect(pending).toHaveLength(2);
    expect(applied).toEqual([100, 250]);
  });

  it('keeps the last reading when a read fails or measures nothing', async () => {
    const reads: Array<() => Promise<number | undefined>> = [
      async () => 300,
      async () => {
        throw new Error('storage closed');
      },
      async () => undefined,
    ];
    const applied: number[] = [];
    const meter = new ContextMeter({
      read: () => (reads.shift() ?? (async () => undefined))(),
      apply: (tokens) => applied.push(tokens),
    });
    await meter.request();
    await meter.request();
    await meter.request();
    expect(applied).toEqual([300]);
  });
});

describe('the live context reading', () => {
  async function until(
    condition: () => boolean | Promise<boolean>,
  ): Promise<void> {
    for (let i = 0; i < 5000 && !(await condition()); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await condition()).toBe(true);
  }

  // The gauge text for a reading against the faux model's 128k window.
  const percentOf = (tokens: number): string =>
    `${Math.round((tokens / 128000) * 100)}% of 128k`;

  it('moves on a tool result mid-turn and comes back on resume', {
    timeout: 20000,
  }, async () => {
    const workspace = tempDir('tui-context-gauge-ws-');
    const sessionsRoot = tempDir('tui-context-gauge-sessions-');
    // About 10k tokens of file: the tool result alone moves a 128k gauge.
    writeFileSync(
      join(workspace, 'big.txt'),
      `${'x'.repeat(99)}\n`.repeat(400),
    );
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([
      fauxToolUse([fauxToolCall('read', { path: 'big.txt' })]),
      async () => {
        await released;
        return fauxAssistantMessage('done');
      },
    ]);
    models.setProvider(faux.provider);
    let booted: TuiLaneBoot | undefined;
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) => {
      booted = await bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
      return booted;
    };
    const measure = async (): Promise<number> => {
      const loop = booted?.loop;
      if (loop?.contextTokens === undefined) throw new Error('no live loop');
      return loop.contextTokens(loop.context);
    };
    const open = (session?: string) => {
      const fake = terminalRig(120, 30);
      const exit = runTuiCommand(session === undefined ? {} : { session }, {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane,
      });
      return { fake, exit };
    };

    const first = open();
    await until(() => first.fake.counts.started === 1);
    for (const ch of 'read the big file') first.fake.feed(ch);
    first.fake.feed('\r');
    // The read's result is committed while the next response is held back:
    // only a live reading can move the gauge now.
    await until(async () => {
      const loop = booted?.loop;
      if (loop === undefined) return false;
      const entries = await loop.entries(loop.context);
      return entries.some((entry) => ToolResultEntry.is(entry));
    });
    const midTurn = await measure();
    expect(midTurn).toBeGreaterThan(10000);
    await until(() => first.fake.frame.includes(percentOf(midTurn)));
    release();
    await until(() => first.fake.frame.includes('done'));
    const settled = await measure();
    await until(() => first.fake.frame.includes(percentOf(settled)));
    first.fake.feed('\x04');
    expect((await first.exit).exitCode).toBe(0);

    // A resumed session shows its context from the first frame.
    const [sessionId] = readdirSync(sessionsRoot).filter(
      (name) => !name.startsWith('.'),
    );
    if (sessionId === undefined) throw new Error('no session was written');
    const second = open(sessionId);
    await until(() => second.fake.counts.started === 1);
    await until(() => second.fake.frame.includes(percentOf(settled)));
    second.fake.feed('\x04');
    expect((await second.exit).exitCode).toBe(0);
  });
});
