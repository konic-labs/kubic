// Run guard (issue #84, follow-up to #81 live smoke G2): a never-settling
// model terminates within the bound with a §78 budget_exhausted exit and
// the journal:/usage:/trajectory: ref triple intact. Faux-only: the lane
// is stubbed at the boot seam, the drive loop runs real — zero network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { bootSoloLane, type SoloLane } from '../../worker/src/lane/solo.js';
import {
  type AgentLane,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  mapTerminusToExitCode,
  runRunCommand,
} from './run-cli.js';

vi.mock('../../worker/src/lane/solo.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../worker/src/lane/solo.js')>();
  return { ...actual, bootSoloLane: vi.fn() };
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-guard-'));
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function deps() {
  return {
    sessionsRoot: tmpRoot(),
    models: fauxModels(['unused']),
    env: new FakeExecutionEnv({}),
  };
}

function stubLane(drive: AgentLane['drive']): AgentLane {
  return {
    accept: async () => ({
      ok: true as const,
      value: { operationId: 'op-guard', kind: 'run' as const, startedAt: 0 },
    }),
    findEntries: async () => [],
    drive,
  } as unknown as AgentLane;
}

function bootWith(lane: AgentLane): void {
  vi.mocked(bootSoloLane).mockResolvedValue({ lane } as unknown as SoloLane);
}

function completedResult(
  overrides: Partial<HeadlessRunResult> = {},
): HeadlessRunResult {
  return {
    terminus: 'completed',
    summary: 'did the thing',
    sessionId: 'sess-1',
    journalRef: 'journal:sess-1',
    usageRef: 'usage:sess-1',
    trajectoryRef: 'trajectory:sess-1',
    ...overrides,
  };
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

beforeEach(() => {
  bootWith(
    stubLane((() => new Promise<never>(() => {})) as AgentLane['drive']),
  );
});

describe('run guard flags (issue #84)', () => {
  it('rejects --timeout without a value with exit 2', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', 'hi', '--timeout'], {
      out: o.write,
      run: async () => {
        called = true;
        return completedResult();
      },
    });
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/--timeout needs a value/);
  });

  it.each(['abc', '0', '-5', '1.5'])(
    'rejects --timeout %s with exit 2',
    async (value) => {
      const o = out();
      let called = false;
      const exit = await runRunCommand(['-p', 'hi', '--timeout', value], {
        out: o.write,
        run: async () => {
          called = true;
          return completedResult();
        },
      });
      expect(exit).toBe(2);
      expect(called).toBe(false);
      expect(o.lines.join('\n')).toMatch(/invalid --timeout/);
    },
  );

  it.each(['nope', '0', '-2', '2.5'])(
    'rejects --max-turns %s with exit 2',
    async (value) => {
      const o = out();
      let called = false;
      const exit = await runRunCommand(['-p', 'hi', '--max-turns', value], {
        out: o.write,
        run: async () => {
          called = true;
          return completedResult();
        },
      });
      expect(exit).toBe(2);
      expect(called).toBe(false);
      expect(o.lines.join('\n')).toMatch(/invalid --max-turns/);
    },
  );

  it('rejects --timeout above the setTimeout ceiling with exit 2', async () => {
    const o = out();
    let called = false;
    const exit = await runRunCommand(['-p', 'hi', '--timeout', '3000000000'], {
      out: o.write,
      run: async () => {
        called = true;
        return completedResult();
      },
    });
    // Above 2^31-1 ms setTimeout clamps to 1 ms (TimeoutOverflowWarning): a
    // "bound" that fires immediately is a lie, so it is refused at parse time.
    expect(exit).toBe(2);
    expect(called).toBe(false);
    expect(o.lines.join('\n')).toMatch(/invalid --timeout/);
    expect(o.lines.join('\n')).toMatch(/2147483647/);
  });

  it('accepts the largest usable --timeout', async () => {
    const o = out();
    const seen: { options?: unknown } = {};
    const exit = await runRunCommand(['-p', 'hi', '--timeout', '2147483647'], {
      out: o.write,
      run: async (_prompt: string, options: unknown) => {
        seen.options = options;
        return completedResult();
      },
    });
    expect(exit).toBe(0);
    expect(seen.options).toEqual({
      sessionId: undefined,
      timeoutMs: 2_147_483_647,
      maxTurns: undefined,
    });
  });

  it('forwards --timeout/--max-turns to the runner', async () => {
    const o = out();
    const seen: { prompt?: string; options?: unknown } = {};
    const exit = await runRunCommand(
      ['-p', 'hi', '--timeout', '60000', '--max-turns', '10'],
      {
        out: o.write,
        run: async (prompt: string, options: unknown) => {
          seen.prompt = prompt;
          seen.options = options;
          return completedResult();
        },
      },
    );
    expect(exit).toBe(0);
    expect(seen.prompt).toBe('hi');
    expect(seen.options).toEqual({
      sessionId: undefined,
      timeoutMs: 60000,
      maxTurns: 10,
    });
  });

  it('passes the guard through unset by default (headless owns the default)', async () => {
    const o = out();
    const seen: { options?: unknown } = {};
    await runRunCommand(['-p', 'hi'], {
      out: o.write,
      run: async (_prompt: string, options: unknown) => {
        seen.options = options;
        return completedResult();
      },
    });
    expect(seen.options).toEqual({
      sessionId: undefined,
      timeoutMs: undefined,
      maxTurns: undefined,
    });
  });
});

describe('run guard mapping (issue #84)', () => {
  it('pins the default wall-clock bound at 5 minutes', () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(300_000);
  });

  it('maps a never-settling drive to budget_exhausted with the ref triple intact', {
    timeout: 10_000,
  }, async () => {
    const result = await runHeadlessPrompt(
      'think forever',
      { timeoutMs: 60 },
      deps(),
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(mapTerminusToExitCode(result.terminus)).toBe(3);
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.journalRef).toBe(`journal:${result.sessionId}`);
    expect(result.usageRef).toBe(`usage:${result.sessionId}`);
    expect(result.trajectoryRef).toBe(`trajectory:${result.sessionId}`);
    expect(result.error?.kind).toBe('budget_exhausted');
    expect(result.error?.message).toMatch(/timed out after 60ms/);
  });

  it('applies the default bound when no override is passed', async () => {
    vi.useFakeTimers();
    try {
      const pending = runHeadlessPrompt('think forever', {}, deps());
      await vi.advanceTimersByTimeAsync(DEFAULT_RUN_TIMEOUT_MS);
      const result = await pending;
      expect(result.terminus).toBe('budget_exhausted');
      expect(mapTerminusToExitCode(result.terminus)).toBe(3);
      expect(result.journalRef).toBe(`journal:${result.sessionId}`);
      expect(result.usageRef).toBe(`usage:${result.sessionId}`);
      expect(result.trajectoryRef).toBe(`trajectory:${result.sessionId}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a turn-spinning drive to budget_exhausted once maxTurns is exceeded', async () => {
    const drive = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: 'waiting' as const,
        operationId: 'op-guard',
        reason: 'retry' as const,
        notBefore: Date.now(),
      },
    }));
    bootWith(stubLane(drive as unknown as AgentLane['drive']));
    const result = await runHeadlessPrompt(
      'spin forever',
      { maxTurns: 3 },
      deps(),
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(mapTerminusToExitCode(result.terminus)).toBe(3);
    expect(drive).toHaveBeenCalledTimes(3);
    expect(result.journalRef).toBe(`journal:${result.sessionId}`);
    expect(result.usageRef).toBe(`usage:${result.sessionId}`);
    expect(result.trajectoryRef).toBe(`trajectory:${result.sessionId}`);
    expect(result.error?.message).toMatch(
      /turn budget exhausted after 3 turns/,
    );
  });

  it.each([{ timeoutMs: -1 }, { timeoutMs: 0 }, { maxTurns: 0 }])(
    'rejects an invalid guard override %j with the usage terminus',
    async (override) => {
      const result = await runHeadlessPrompt('hi', override, deps());
      expect(result.terminus).toBe('usage');
      expect(mapTerminusToExitCode(result.terminus)).toBe(2);
      expect(result.sessionId).toBe('unassigned');
      expect(vi.mocked(bootSoloLane)).not.toHaveBeenCalled();
    },
  );

  it('rejects a timeoutMs above the setTimeout ceiling (direct caller)', async () => {
    const result = await runHeadlessPrompt(
      'hi',
      { timeoutMs: 3_000_000_000 },
      deps(),
    );
    expect(result.terminus).toBe('usage');
    expect(mapTerminusToExitCode(result.terminus)).toBe(2);
    expect(result.sessionId).toBe('unassigned');
    expect(result.error?.message).toMatch(/max 2147483647/);
    expect(vi.mocked(bootSoloLane)).not.toHaveBeenCalled();
  });
});
