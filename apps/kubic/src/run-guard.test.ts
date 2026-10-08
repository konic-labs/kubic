// Run guard: a never-settling model terminates within the bound with a
// timeout or turn-limit exit and the journal:/usage:/trajectory: ref
// triple intact. Faux-only, real lane:
// the wall clock, the turn count and the signal handlers all run for real —
// zero network.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
  mapTerminusToExitCode,
  parseRunMaxTurns,
  parseRunTimeout,
  runRunCommand,
} from '../../../packages/host/src/run-cli.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-guard-'));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

// A model that never answers: the run's guards are the only way out.
function hangingModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([() => new Promise<never>(() => undefined)]);
  return models;
}

// A model that keeps calling a tool: every response commits one usage event,
// which is the turn unit `--max-turns` bounds.
function spinningModels(rounds: number): MutableModels {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'spin\n');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: rounds }, () =>
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
    ),
  );
  return models;
}

// The trajectory ref names the written file, and a guard exhaustion is
// recorded with its failure category (never a missing one): the wall-clock
// bound is `timeout`, `--max-turns` is `turn_limit`, and both carry the
// `run_limit` category.
function expectGuardTrajectory(
  result: HeadlessRunResult,
  status: 'timeout' | 'turn_limit',
): void {
  expect(
    result.trajectoryRef.endsWith(join(result.sessionId, 'trajectory.json')),
  ).toBe(true);
  const exported = parseTrajectoryExportJSON(
    readFileSync(result.trajectoryRef, 'utf8'),
  );
  expect(exported.result.status).toBe(status);
  expect(exported.result.failureCategory).toBe('run_limit');
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
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

beforeEach(() => {
  // The solo notice is not under test here (solo-notice-prod.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('run guard flags', () => {
  // The value rules commander applies to --timeout/--max-turns
  // (apps/kubic/src/commands/session.ts wires them; a refusal exits 2 there —
  // pinned in solo.test.ts). A missing value is commander's own error.
  it.each(['abc', '0', '-5', '1.5'])('refuses --timeout %s', (value) => {
    expect(() => parseRunTimeout(value)).toThrow(/need a positive integer/);
  });

  it.each(['nope', '0', '-2', '2.5'])('refuses --max-turns %s', (value) => {
    expect(() => parseRunMaxTurns(value)).toThrow(/need a positive integer/);
  });

  it('refuses a --timeout above the setTimeout ceiling', () => {
    // Above 2^31-1 ms setTimeout clamps to 1 ms (TimeoutOverflowWarning): a
    // "bound" that fires immediately is a lie, so it is refused at parse time.
    expect(() => parseRunTimeout('3000000000')).toThrow(/max 2147483647/);
    expect(parseRunTimeout('2147483647')).toBe(2_147_483_647);
    expect(parseRunMaxTurns('10')).toBe(10);
  });

  it('accepts the largest usable --timeout', async () => {
    const o = out();
    const seen: { options?: unknown } = {};
    const exit = (
      await runRunCommand(
        { prompt: 'hi', timeoutMs: 2147483647 },
        {
          out: o.write,
          run: async (_prompt: string, options: unknown) => {
            seen.options = options;
            return completedResult();
          },
        },
      )
    ).exitCode;
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
    const exit = (
      await runRunCommand(
        { prompt: 'hi', timeoutMs: 60000, maxTurns: 10 },
        {
          out: o.write,
          run: async (prompt: string, options: unknown) => {
            seen.prompt = prompt;
            seen.options = options;
            return completedResult();
          },
        },
      )
    ).exitCode;
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
    await runRunCommand(
      { prompt: 'hi' },
      {
        out: o.write,
        run: async (_prompt: string, options: unknown) => {
          seen.options = options;
          return completedResult();
        },
      },
    );
    expect(seen.options).toEqual({
      sessionId: undefined,
      timeoutMs: undefined,
      maxTurns: undefined,
    });
  });
});

describe('run guard mapping', () => {
  it('pins the default wall-clock bound at 5 minutes', () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(300_000);
  });

  it('maps a never-settling turn to timeout (exit 1) with the ref triple intact', {
    timeout: 10_000,
  }, async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'think forever',
      { timeoutMs: 60 },
      {
        sessionsRoot: root,
        models: hangingModels(),
        env: new FakeExecutionEnv({}),
      },
    );
    // The default/user wall clock is a timeout, never a turn limit.
    expect(result.terminus).toBe('timeout');
    expect(mapTerminusToExitCode(result.terminus)).toBe(1);
    expect(result.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.journalRef).toBe(`journal:${result.sessionId}`);
    expect(result.usageRef).toBe(`usage:${result.sessionId}`);
    expectGuardTrajectory(result, 'timeout');
    expect(result.error?.kind).toBe('timeout');
    expect(result.error?.message).toMatch(/timed out after 60ms/);
  });

  it('a `kubic run --timeout` that never settles reports status timeout and exits 1', {
    timeout: 10_000,
  }, async () => {
    // The acceptance shape: the real headless runner behind the command's
    // own --timeout wiring, faux provider, real wall clock — the envelope
    // names `timeout` and the exit code is 1, never the turn-limit code.
    const o = out();
    const exit = (
      await runRunCommand(
        { prompt: 'think forever', timeoutMs: 60, json: true },
        {
          out: o.write,
          run: (prompt, options) =>
            runHeadlessPrompt(prompt, options, {
              sessionsRoot: tmpRoot(),
              models: hangingModels(),
              env: new FakeExecutionEnv({}),
            }),
        },
      )
    ).exitCode;
    expect(exit).toBe(1);
    expect(o.lines).toHaveLength(1);
    const envelope = JSON.parse(o.lines[0] as string) as {
      ok: boolean;
      status: string;
      exitCode: number;
      error?: { kind: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('timeout');
    expect(envelope.exitCode).toBe(1);
    expect(envelope.error?.kind).toBe('timeout');
  });

  it('applies the default bound when no override is passed', async () => {
    vi.useFakeTimers();
    try {
      const pending = runHeadlessPrompt(
        'think forever',
        {},
        {
          sessionsRoot: tmpRoot(),
          models: hangingModels(),
          env: new FakeExecutionEnv({}),
        },
      );
      // Let the boot's real I/O (session store, harness) settle before the
      // clock moves, then exhaust the default bound and the bounded cleanup
      // that follows it (2 s abort + 2 s close, see LANE_ABORT_BOUND_MS).
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DEFAULT_RUN_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.terminus).toBe('timeout');
      expect(mapTerminusToExitCode(result.terminus)).toBe(1);
      expect(result.journalRef).toBe(`journal:${result.sessionId}`);
      expect(result.usageRef).toBe(`usage:${result.sessionId}`);
      expectGuardTrajectory(result, 'timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a turn-spinning run to turn_limit once maxTurns is exceeded', {
    timeout: 10_000,
  }, async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'spin forever',
      { maxTurns: 3 },
      {
        sessionsRoot: root,
        models: spinningModels(6),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('turn_limit');
    expect(mapTerminusToExitCode(result.terminus)).toBe(3);
    expect(result.journalRef).toBe(`journal:${result.sessionId}`);
    expect(result.usageRef).toBe(`usage:${result.sessionId}`);
    expectGuardTrajectory(result, 'turn_limit');
    expect(result.error?.message).toMatch(/turn limit reached after 3 turns/);
  });

  it.each([{ timeoutMs: -1 }, { timeoutMs: 0 }, { maxTurns: 0 }])(
    'rejects an invalid guard override %j with the usage terminus',
    async (override) => {
      const root = tmpRoot();
      const result = await runHeadlessPrompt('hi', override, {
        sessionsRoot: root,
        models: fauxModels(['unused']),
        env: new FakeExecutionEnv({}),
      });
      expect(result.terminus).toBe('usage');
      expect(mapTerminusToExitCode(result.terminus)).toBe(2);
      expect(result.sessionId).toBe('unassigned');
      // Refused before any store or lane existed.
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it('rejects a timeoutMs above the setTimeout ceiling (direct caller)', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hi',
      { timeoutMs: 3_000_000_000 },
      {
        sessionsRoot: root,
        models: fauxModels(['unused']),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('usage');
    expect(mapTerminusToExitCode(result.terminus)).toBe(2);
    expect(result.sessionId).toBe('unassigned');
    expect(result.error?.message).toMatch(/max 2147483647/);
    expect(readdirSync(root)).toEqual([]);
  });
});
