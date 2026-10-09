// Every way `kubic tui` can end restores the terminal: SIGTERM and SIGHUP run
// the same shutdown as SIGINT (mid-turn drain included) and exit 128+signo; an
// exception in input or render, and an unhandled rejection, restore the screen
// before the error is reported; the normal quit drains stdin so a late
// key-release never leaks into the shell.
//
// The signal/exception source is injected (an EventEmitter), so the test
// runner is never signalled. Faux provider only; temp dirs and listeners are
// cleaned up in afterEach.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationKillRegistry } from '@kubic/agent/lane/abort';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import type { TuiProcessEvents, TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';

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
  let throwOnWrite = false;
  const rig = terminalRig(100, 30, {
    onStop: () => log.push('TERM-STOP'),
    onDrain: () => log.push('DRAIN'),
    onWrite: (data) => {
      if (throwOnWrite) {
        throwOnWrite = false;
        throw new Error('render exploded');
      }
      log.push(`TERM:${data}`);
    },
  });
  return {
    counts: rig.counts,
    armWriteFailure: () => {
      throwOnWrite = true;
    },
    feed: rig.feed,
    terminal: rig.terminal,
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
      colorLevel: 'none',
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

describe('terminal restore on every exit path', () => {
  it('SIGTERM runs shutdown once, leaves the alt screen, closes the session and exits 143', async () => {
    const events: string[] = [];
    const run = start(viewerBoot(events));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit('SIGTERM', 'SIGTERM');
    expect((await run.exit).exitCode).toBe(143);
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
    expect((await run.exit).exitCode).toBe(130);
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
          // The placement signal: `run-start` is the durable equivalent of
          // the old admission's operation id, and keys the kill registry
          // by the conversation id.
          subscribe: async (sink, context) => {
            const stop = await loop.subscribe((event) => {
              if (event.type === 'run-start') admitted = loop.killsKey;
              sink(event);
            }, context);
            return stop;
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
    expect((await run.exit).exitCode).toBe(129);
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
        runTurn: () => {
          accepted = true;
          return new Promise(() => {});
        },
        subscribe: async () => async () => {},
        entries: async () => [],
        abort: async () => {},
        forgetKills: () => {},
        killsKey: 'conversation',
        kills: { track: () => {}, drain: () => [] } as never,
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
    expect((await run.exit).exitCode).toBe(1);
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
    expect((await run.exit).exitCode).toBe(1);
    expect(run.log.join('')).toContain('\x1b[?1049l');
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.errors.join('\n')).toContain('late promise');
    expect(run.exits).toEqual([1]);
  });

  it('an uncaught exception restores the terminal and exits non-zero', async () => {
    const run = start(viewerBoot([]));
    await waitFor(() => run.fake.counts.started === 1);
    run.signals.emit('uncaughtException', new Error('boom'), 'uncaught');
    expect((await run.exit).exitCode).toBe(1);
    expect(run.fake.counts.stopped).toBe(1);
    expect(run.errors.join('\n')).toContain('boom');
  });

  it('the normal quit drains stdin before the terminal stops', async () => {
    const run = start(viewerBoot([]));
    await waitFor(() => run.fake.counts.started === 1);
    run.fake.feed('\x04');
    expect((await run.exit).exitCode).toBe(0);
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
        colorLevel: 'none',
        bootLane: viewerBoot([]),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    expect(process.listenerCount('SIGTERM')).toBe((before[1] ?? 0) + 1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
    expect(names.map((name) => process.listenerCount(name))).toEqual(before);
  });
});

// On quit the final document is printed on the MAIN
// screen — after `?1049l` — and carries the last assistant cell.
describe('the final document reaches the main screen', () => {
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
          entries: async (context) => {
            const entries = await loop.entries(context);
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
    run.fake.feed('\x04');
    expect((await run.exit).exitCode).toBe(0);
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
