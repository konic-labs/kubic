// Every way `kubic tui` can end restores the terminal (issue #313; §16.1,
// §18): SIGTERM and SIGHUP run the same shutdown as SIGINT (mid-turn drain
// included) and exit 128+signo; an exception in input or render, and an
// unhandled rejection, restore the screen before the error is reported; the
// normal quit drains stdin so a late key-release never leaks into the shell.
//
// The signal/exception source is injected (an EventEmitter), so the test
// runner is never signalled. Faux provider only; temp dirs and listeners are
// cleaned up in afterEach.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiProcessEvents,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import type { OperationKillRegistry } from '../../worker/src/lane/abort.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-restore-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// One ordered log shared by the terminal and the printer.
function recordingTerminal(log: string[]) {
  const counts = { started: 0, stopped: 0, drained: 0 };
  let handler: ((data: string) => void) | undefined;
  let throwOnWrite = false;
  return {
    counts,
    armWriteFailure: () => {
      throwOnWrite = true;
    },
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {
        counts.stopped += 1;
        log.push('TERM-STOP');
      },
      drainInput: () => {
        counts.drained += 1;
        log.push('DRAIN');
        return Promise.resolve();
      },
      write: (data: string) => {
        if (throwOnWrite) {
          throwOnWrite = false;
          throw new Error('render exploded');
        }
        log.push(`TERM:${data}`);
      },
      get columns(): number {
        return 100;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
        return false;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    },
  };
}

async function waitFor(condition: () => boolean, ticks = 2500): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// A viewer boot (no loop) that records its close.
function viewerBoot(events: string[]): TuiRunDeps['bootLane'] {
  return async () => ({
    sessionId: 's1',
    model: 'faux/test',
    close: () => {
      events.push('close');
    },
  });
}

function emitter(): EventEmitter & TuiProcessEvents {
  return new EventEmitter() as EventEmitter & TuiProcessEvents;
}

const ALL_EVENTS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'uncaughtException',
  'unhandledRejection',
] as const;

function start(
  bootLane: TuiRunDeps['bootLane'],
  extra: Partial<TuiRunDeps> = {},
) {
  const log: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const fake = recordingTerminal(log);
  const signals = emitter();
  const exit = runTuiCommand(
    {},
    {
      out: (line) => log.push(`OUT:${line}`),
      err: (line) => errors.push(line),
      createTerminal: () => fake.terminal,
      bootLane,
      signals,
      exit: (code) => {
        exits.push(code);
      },
      ...extra,
    },
  );
  return { log, errors, exits, fake, signals, exit };
}

describe('terminal restore on every exit path (issue #313)', () => {
  it('SIGTERM runs shutdown once, leaves the alt screen, closes the session and exits 143', async () => {
    const events: string[] = [];
    const run = start(viewerBoot(events));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit('SIGTERM', 'SIGTERM');
    expect(await run.exit).toBe(143);
    expect(run.log.join('')).toContain('\x1b[?1049l');
    expect(run.fake.counts.stopped).toBe(1);
    expect(events).toEqual(['close']);
    for (const name of ALL_EVENTS)
      expect(run.signals.listenerCount(name)).toBe(0);
  });

  it('SIGINT then SIGTERM in quick succession runs shutdown exactly once', async () => {
    const events: string[] = [];
    const run = start(viewerBoot(events));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit('SIGINT', 'SIGINT');
    run.signals.emit('SIGTERM', 'SIGTERM');
    expect(await run.exit).toBe(130);
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.fake.counts.drained).toBe(1);
    expect(events).toEqual(['close']);
  });

  it('SIGHUP during a turn drains it and exits non-zero', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    const events: string[] = [];
    let admitted: string | undefined;
    let kills: OperationKillRegistry | undefined;
    const bootLane: TuiRunDeps['bootLane'] = async (sessionId, answer) => {
      const faux = fauxProvider();
      faux.setResponses([
        async () => {
          await new Promise(() => {});
          return fauxAssistantMessage('never');
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const boot = await bootTuiLane(sessionId, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        skills: { homeDir: workspace, cwd: workspace, trusted: false },
        ...(answer === undefined ? {} : { answer }),
      });
      const loop = boot.loop;
      if (loop === undefined) throw new Error('no loop');
      kills = loop.kills;
      return {
        ...boot,
        loop: {
          ...loop,
          accept: async (prompt, context) => {
            const result = await loop.accept(prompt, context);
            if (result.ok) admitted = result.value.operationId;
            return result;
          },
        },
        close: async () => {
          events.push('close');
          await boot.close?.();
        },
      };
    };
    const run = start(bootLane, {
      setDrainTimer: (_ms, fire) => {
        const timer = setTimeout(fire, 200);
        return () => clearTimeout(timer);
      },
    });
    await waitFor(() => run.fake.counts.started === 1);
    for (const ch of 'hang') run.fake.feed(ch);
    run.fake.feed('\r');
    await waitFor(() => admitted !== undefined);
    kills?.track(admitted ?? '', () => {
      events.push('kill');
    });
    run.signals.emit('SIGHUP', 'SIGHUP');
    expect(await run.exit).toBe(129);
    expect(events).toEqual(['kill', 'close']);
    expect(run.log.join('')).toContain('\x1b[?1049l');
  });

  it('an exception thrown from the input listener restores the terminal before exiting non-zero', async () => {
    const events: string[] = [];
    let accepted = false;
    const bootLane: TuiRunDeps['bootLane'] = async () => ({
      sessionId: 's1',
      model: 'faux/test',
      close: () => {
        events.push('close');
      },
      loop: {
        accept: () => {
          accepted = true;
          return new Promise(() => {});
        },
        lane: {} as never,
        requestAbort: async () => ({ ok: true }) as never,
        findEntries: async () => [],
        events: (() => () => {}) as never,
        kills: { track: () => () => {}, drain: () => [] } as never,
        context: {} as never,
      },
    });
    const run = start(bootLane);
    await waitFor(() => run.fake.counts.started === 1);
    run.fake.feed('x');
    run.fake.armWriteFailure();
    // Enter submits: the submit path paints synchronously, and that paint
    // throws inside the input listener.
    run.fake.feed('\r');
    expect(await run.exit).toBe(1);
    expect(accepted).toBe(false);
    const restoredAt = run.log.findIndex((entry) => entry.includes('?1049l'));
    expect(restoredAt).toBeGreaterThanOrEqual(0);
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.errors.join('\n')).toContain('render exploded');
    expect(run.exits).toEqual([1]);
    for (const name of ALL_EVENTS)
      expect(run.signals.listenerCount(name)).toBe(0);
  });

  it('an unhandled rejection restores the terminal and exits non-zero', async () => {
    const run = start(viewerBoot([]));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit(
      'unhandledRejection',
      new Error('late promise'),
      Promise.resolve(),
    );
    expect(await run.exit).toBe(1);
    expect(run.log.join('')).toContain('\x1b[?1049l');
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.errors.join('\n')).toContain('late promise');
    expect(run.exits).toEqual([1]);
  });

  it('an uncaught exception restores the terminal and exits non-zero', async () => {
    const run = start(viewerBoot([]));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit('uncaughtException', new Error('boom'), 'uncaught');
    expect(await run.exit).toBe(1);
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.errors.join('\n')).toContain('boom');
  });

  it('the normal quit drains stdin before the terminal stops', async () => {
    const run = start(viewerBoot([]));
    await waitFor(() => run.fake.counts.started === 1);
    run.fake.feed('\x1b');
    expect(await run.exit).toBe(0);
    const drain = run.log.indexOf('DRAIN');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(drain).toBeLessThan(run.log.indexOf('TERM-STOP'));
    expect(run.exits).toEqual([]);
  });

  it('leaves no process listeners behind after it resolves', async () => {
    const names = [...ALL_EVENTS];
    const before = names.map((name) => process.listenerCount(name));
    const log: string[] = [];
    const fake = recordingTerminal(log);
    const exit = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        bootLane: viewerBoot([]),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    expect(process.listenerCount('SIGTERM')).toBe((before[1] ?? 0) + 1);
    fake.feed('\x03');
    expect(await exit).toBe(0);
    expect(names.map((name) => process.listenerCount(name))).toEqual(before);
  });
});

// Issue #314 (§16.1): on quit the final document is printed on the MAIN
// screen — after `?1049l` — and carries the last assistant cell.
describe('the final document reaches the main screen (issue #314)', () => {
  it('prints every document line after leaving the alt screen, including the last answer', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    let settled = false;
    const bootLane: TuiRunDeps['bootLane'] = async (sessionId, answer) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage('the final answer is 42')]);
      const models = createModels();
      models.setProvider(faux.provider);
      const boot = await bootTuiLane(sessionId, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        skills: { homeDir: workspace, cwd: workspace, trusted: false },
        ...(answer === undefined ? {} : { answer }),
      });
      const loop = boot.loop;
      if (loop === undefined) throw new Error('no loop');
      return {
        ...boot,
        loop: {
          ...loop,
          findEntries: async (query, context) => {
            const entries = await loop.findEntries(query, context);
            if (JSON.stringify(entries).includes('the final answer is 42'))
              settled = true;
            return entries;
          },
        },
      };
    };
    const run = start(bootLane);
    await waitFor(() => run.fake.counts.started === 1);
    for (const ch of 'answer') run.fake.feed(ch);
    run.fake.feed('\r');
    await waitFor(() => settled);
    // Let the settlement paint land before quitting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    run.fake.feed('\x1b');
    expect(await run.exit).toBe(0);
    const exitAlt = run.log.findIndex(
      (entry) => entry.startsWith('TERM:') && entry.includes('?1049l'),
    );
    const autowrap = run.log.findIndex(
      (entry, index) =>
        index <= exitAlt && entry.startsWith('TERM:') && entry.includes('?7h'),
    );
    const outs = run.log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('OUT:'));
    expect(exitAlt).toBeGreaterThanOrEqual(0);
    expect(autowrap).toBeGreaterThanOrEqual(0);
    expect(outs.length).toBeGreaterThan(0);
    expect(outs.every(({ index }) => index > exitAlt)).toBe(true);
    expect(outs.map(({ entry }) => entry).join('\n')).toContain(
      'the final answer is 42',
    );
  });
});
