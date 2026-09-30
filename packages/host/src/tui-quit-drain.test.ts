// Quitting `kubic tui` mid-turn drains the operation (issue #312; §18,
// §42.5, #109): Esc, a second Ctrl-C, Ctrl-D or SIGINT while a turn runs
// must abort the operation, kill its detached tool process groups, wait
// (bounded) for it to settle and only then run the §42.5 sweep and close
// the session — mirroring `kubic run`'s drain-before-sweep contract.
//
// Real code end to end: the prod bootTuiLane re-rooted onto temp state, a
// real NodeExecutionEnv (a real slow bash) inside a temp workspace, and a
// recording fake Terminal under the real alt-screen. Faux provider only.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiLaneBoot,
  TuiOrchestratorTurn,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  type AgentLane,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];
const pids: number[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-quit-drain-'));
  made.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Never leak a child: anything a failed test left behind is killed here.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;
type Step =
  | Parameters<typeof fauxAssistantMessage>[0]
  | (() => Promise<FauxMessage>);

function recordingTerminal() {
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 120;
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

interface Harness {
  sessionsRoot: string;
  workspace: string;
  events: string[];
  admitted: string[];
  boots: TuiLaneBoot[];
  bootLane: TuiRunDeps['bootLane'];
}

// The prod boot, re-rooted, with the admitted operation ids and the order of
// abort / kill / close recorded (the loop surface is passed through intact).
function harness(steps: Step[]): Harness {
  const sessionsRoot = tmpRoot();
  const workspace = tmpRoot();
  const events: string[] = [];
  const admitted: string[] = [];
  const boots: TuiLaneBoot[] = [];
  const bootLane: TuiRunDeps['bootLane'] = async (sessionId, answer) => {
    const faux = fauxProvider();
    faux.setResponses(
      steps.map((step) =>
        typeof step === 'function' ? step : fauxAssistantMessage(step),
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(sessionId, {
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      ...(answer === undefined ? {} : { answer }),
    });
    boots.push(boot);
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    return {
      ...boot,
      loop: {
        ...loop,
        accept: async (prompt, context) => {
          const result = await loop.accept(prompt, context);
          if (result.ok) admitted.push(result.value.operationId);
          return result;
        },
        requestAbort: async (operationId, context) => {
          events.push(`requestAbort:${operationId}`);
          return loop.requestAbort(operationId, context);
        },
      },
      close: async () => {
        events.push('close');
        await boot.close?.();
      },
    };
  };
  return { sessionsRoot, workspace, events, admitted, boots, bootLane };
}

function start(
  h: Harness,
  extra: Partial<TuiRunDeps> = {},
): {
  fake: ReturnType<typeof recordingTerminal>;
  exit: Promise<number>;
} {
  const fake = recordingTerminal();
  const exit = runTuiCommand(
    {},
    {
      out: () => {},
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane: h.bootLane,
      ...extra,
    },
  );
  return { fake, exit };
}

async function submit(
  fake: ReturnType<typeof recordingTerminal>,
  prompt: string,
): Promise<void> {
  await waitFor(() => fake.counts.started === 1);
  for (const ch of prompt) fake.feed(ch);
  fake.feed('\r');
}

describe('quitting mid-turn drains the operation (issue #312)', () => {
  it('a real slow bash leaves no surviving child and the session records the abort', async () => {
    const h = harness([
      [
        fauxToolCall('bash', {
          command: 'echo $$ > pid.txt; sleep 30; echo late > late.txt',
        }),
      ],
      'never reached',
    ]);
    const { fake, exit } = start(h);
    await submit(fake, 'run the slow thing');
    const pidFile = join(h.workspace, 'pid.txt');
    await waitFor(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '',
    );
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    pids.push(pid);
    expect(alive(pid)).toBe(true);
    fake.feed('\x1b'); // Esc quits mid-turn
    expect(await exit).toBe(0);
    await waitFor(() => !alive(pid), 500);
    expect(existsSync(join(h.workspace, 'late.txt'))).toBe(false);
    const opId = h.admitted[0] ?? '';
    expect(h.events).toEqual([`requestAbort:${opId}`, 'close']);
    // Resume: the operation settled with a terminal status, nothing dangles.
    const resumed = await h.bootLane(h.boots[0]?.sessionId);
    const lane = resumed.loop?.lane as unknown as AgentLane;
    const info = await lane.inspectExecution(
      resumed.loop?.context as Parameters<AgentLane['inspectExecution']>[0],
    );
    expect(info.current).toBeNull();
    const record = await lane.getResult(
      opId,
      resumed.loop?.context as Parameters<AgentLane['getResult']>[1],
    );
    expect(record?.status).toBe('aborted');
    await resumed.close?.();
  });

  it('invokes requestAbort for the active op and every registered kill before close', async () => {
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([
      async () => {
        await gated;
        return fauxAssistantMessage('never delivered');
      },
    ]);
    const { fake, exit } = start(h);
    await submit(fake, 'hold');
    await waitFor(() => h.admitted.length === 1);
    const opId = h.admitted[0] ?? '';
    const kills = h.boots[0]?.loop?.kills;
    kills?.track(opId, () => {
      h.events.push('kill:1');
      release();
    });
    kills?.track(opId, () => {
      h.events.push('kill:2');
    });
    fake.feed('\x04'); // Ctrl-D on an empty draft quits
    expect(await exit).toBe(0);
    expect(h.events).toEqual([
      `requestAbort:${opId}`,
      'kill:1',
      'kill:2',
      'close',
    ]);
  });

  it('the sweep runs after the operation settles, so a late write is journaled', async () => {
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([
      async () => {
        await gated;
        return fauxAssistantMessage('never delivered');
      },
    ]);
    const { fake, exit } = start(h);
    await submit(fake, 'hold');
    await waitFor(() => h.admitted.length === 1);
    const opId = h.admitted[0] ?? '';
    // The killed "tool" writes once more on its way out, then the
    // operation settles: a sweep that ran before settlement would miss it.
    h.boots[0]?.loop?.kills.track(opId, () => {
      setTimeout(() => {
        writeFileSync(join(h.workspace, 'late.txt'), 'late\n');
        release();
      }, 30);
    });
    process.emit('SIGINT');
    // Issue #313: a signalled quit exits 128+signo (SIGINT → 130).
    expect(await exit).toBe(130);
    const sessionId = h.boots[0]?.sessionId ?? '';
    const paths = new FileJournalStore(
      join(h.sessionsRoot, sessionId, 'journal'),
    )
      .entries()
      .map((entry) => entry.path);
    expect(paths).toContain('late.txt');
  });

  it('shows cancelling… during the drain, and a second Ctrl-C still exits within the bound', async () => {
    const h = harness([
      async () => {
        // Never settles on its own: only the bound ends the wait.
        await new Promise(() => {});
        return fauxAssistantMessage('never');
      },
    ]);
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const { fake, exit } = start(h, {
      drainTimeoutMs: 1234,
      setDrainTimer: (ms, fire) => {
        timers.push({ ms, fire });
        return () => {};
      },
    });
    await submit(fake, 'hang');
    await waitFor(() => h.admitted.length === 1);
    fake.feed('\x1b');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    expect(timers.map((timer) => timer.ms)).toEqual([1234]);
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03'); // second Ctrl-C while draining: exit now
    expect(await exit).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  // Issue #306 decision: a held key's repeats never act as a global key.
  // While a quit drains, only a real second Ctrl-C press ends the wait: the
  // Kitty release (`:3`) and repeat (`:2`) events of the SAME key must not.
  it('a held Ctrl-C (Kitty repeat) or its release does not end the drain; a real second press does', async () => {
    const h = harness([
      async () => {
        await new Promise(() => {});
        return fauxAssistantMessage('never');
      },
    ]);
    const { fake, exit } = start(h, {
      setDrainTimer: () => () => {},
    });
    await submit(fake, 'hang');
    await waitFor(() => h.admitted.length === 1);
    fake.feed('\x1b');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    for (const heldOrReleased of [
      '\x1b[99;5:2u', // Ctrl-C key repeat
      '\x1b[99;5:2u',
      '\x1b[99;5:3u', // Ctrl-C key release
    ]) {
      fake.feed(heldOrReleased);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Still draining: the terminal was not restored, the session not closed.
    expect(fake.counts.stopped).toBe(0);
    expect(h.events).not.toContain('close');
    fake.feed('\x1b[99;5u'); // a real Ctrl-C press (Kitty)
    expect(await exit).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  // Issue #312 review: the bound used to cover only the wait AFTER the abort
  // request. A requestAbort that never settles blocked the quit (and the kill
  // drain queued behind it) with no way out — a second Ctrl-C ended a wait
  // nobody was in.
  describe('a requestAbort that never settles', () => {
    function hungAbort(h: Harness): void {
      const inner = h.bootLane;
      h.bootLane = async (sessionId, answer, flags) => {
        const boot = await inner(sessionId, answer, flags);
        const loop = boot.loop;
        if (loop === undefined) throw new Error('no loop');
        return {
          ...boot,
          loop: {
            ...loop,
            requestAbort: () => new Promise(() => {}),
          },
        };
      };
    }
    const settled = async (exit: Promise<number>): Promise<number | 'hung'> =>
      Promise.race([
        exit,
        new Promise<'hung'>((resolve) => setTimeout(resolve, 1500, 'hung')),
      ]);

    it('the drain bound still ends the quit, and the registered kills still run', async () => {
      const h = harness([
        async () => {
          await new Promise(() => {});
          return fauxAssistantMessage('never');
        },
      ]);
      hungAbort(h);
      const timers: Array<() => void> = [];
      const { fake, exit } = start(h, {
        setDrainTimer: (_ms, fire) => {
          timers.push(fire);
          return () => {};
        },
      });
      await submit(fake, 'hang');
      await waitFor(() => h.admitted.length === 1);
      h.boots[0]?.loop?.kills.track(h.admitted[0] ?? '', () => {
        h.events.push('kill');
      });
      fake.feed('\x1b');
      await waitFor(() => timers.length === 1);
      timers[0]?.();
      expect(await settled(exit)).toBe(0);
      // The kill drain is the backstop: it does not wait on the abort request.
      expect(h.events).toEqual(['kill', 'close']);
    });

    // The bound won over the hung abort request and the kills were drained
    // once. A tool that registers its kill AFTER that drain (it was between
    // spawning and tracking) must still be killed before the process exits:
    // the session close drains every admitted operation once more.
    it('a kill registered after the bound fired is still run at the session close', async () => {
      const h = harness([
        async () => {
          await new Promise(() => {});
          return fauxAssistantMessage('never');
        },
      ]);
      hungAbort(h);
      const inner = h.bootLane;
      h.bootLane = async (sessionId, answer, flags) => {
        const boot = await inner(sessionId, answer, flags);
        return {
          ...boot,
          close: async () => {
            // Registered after the quit's drain, before the session closes.
            boot.loop?.kills.track(h.admitted[0] ?? '', () => {
              h.events.push('late-kill');
            });
            await boot.close?.();
          },
        };
      };
      const timers: Array<() => void> = [];
      const { fake, exit } = start(h, {
        setDrainTimer: (_ms, fire) => {
          timers.push(fire);
          return () => {};
        },
      });
      await submit(fake, 'hang');
      await waitFor(() => h.admitted.length === 1);
      h.boots[0]?.loop?.kills.track(h.admitted[0] ?? '', () => {
        h.events.push('kill');
      });
      fake.feed('\x1b');
      await waitFor(() => timers.length === 1);
      timers[0]?.();
      expect(await settled(exit)).toBe(0);
      expect(h.events).toEqual(['kill', 'close', 'late-kill']);
    });

    it('a second Ctrl-C ends the wait', async () => {
      const h = harness([
        async () => {
          await new Promise(() => {});
          return fauxAssistantMessage('never');
        },
      ]);
      hungAbort(h);
      const { fake, exit } = start(h, { setDrainTimer: () => () => {} });
      await submit(fake, 'hang');
      await waitFor(() => h.admitted.length === 1);
      fake.feed('\x1b');
      await waitFor(() => fake.writes.join('').includes('cancelling'));
      fake.feed('\x03');
      expect(await settled(exit)).toBe(0);
      expect(fake.counts.stopped).toBe(1);
    });
  });

  it('an orchestrator drive whose abort never settles is still released by the bound', async () => {
    let releaseBound: () => void = () => {};
    const bound = new Promise<void>((resolve) => {
      releaseBound = resolve;
    });
    const turn = new TuiOrchestratorTurn(
      {
        run: () => new Promise(() => {}),
        abort: () => new Promise<void>(() => {}),
      },
      () => {},
    );
    void turn.run('objective');
    expect(turn.isRunning()).toBe(true);
    let drained = false;
    const draining = turn.drainForQuit(bound).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drained).toBe(false);
    releaseBound();
    await draining;
    expect(drained).toBe(true);
  });

  // Issue #311: the settlement sweep is for a session that goes on. A quit
  // that drains a turn which already ran bash owns its own final sweep
  // (close); the settlement handler must not run a second one.
  it('a turn settled by a quit does not also run the settlement sweep', async () => {
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness([
      // Step 1 ends a bash call (tool-end: the sweep is now "due") ...
      [fauxToolCall('bash', { command: 'true' })],
      // ... and step 2 holds the turn open until the quit kills it.
      async () => {
        await gated;
        return fauxAssistantMessage('never delivered');
      },
    ]);
    let sweeps = 0;
    const inner = h.bootLane;
    h.bootLane = async (sessionId, answer, flags) => {
      const boot = await inner(sessionId, answer, flags);
      const reconcile = boot.reconcile;
      expect(reconcile).toBeDefined();
      return {
        ...boot,
        reconcile: () => {
          sweeps += 1;
          reconcile?.();
        },
      };
    };
    const { fake, exit } = start(h);
    await submit(fake, 'run bash then hold');
    await waitFor(() => h.admitted.length === 1);
    const opId = h.admitted[0] ?? '';
    // The bash call has ended (the tree row turns ✓): the model's second step
    // is the gated one, so the turn is still running.
    await waitFor(() => fake.writes.join('').includes('✓ bash'));
    h.boots[0]?.loop?.kills.track(opId, release);
    fake.feed('\x1b'); // Esc quits mid-turn; the kill releases the gate
    expect(await exit).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sweeps).toBe(0);
  });

  it('the drain bound ends a wait that never settles', async () => {
    const h = harness([
      async () => {
        await new Promise(() => {});
        return fauxAssistantMessage('never');
      },
    ]);
    const timers: Array<() => void> = [];
    const { fake, exit } = start(h, {
      setDrainTimer: (_ms, fire) => {
        timers.push(fire);
        return () => {};
      },
    });
    await submit(fake, 'hang');
    await waitFor(() => h.admitted.length === 1);
    fake.feed('\x1b');
    await waitFor(() => timers.length === 1);
    timers[0]?.();
    expect(await exit).toBe(0);
    expect(h.events.at(-1)).toBe('close');
  });
});

// A quit's last-resort kill (the session close) covers only the operations
// still in flight when the quit starts. A turn that already settled left its
// `KUBIC_BASH_KEEP_BACKGROUND=1` job running on purpose (docs/cli/
// configuration.md: it outlives Kubic), and a settled turn's stale kill could
// also hit a recycled pid's process group.
describe('quitting after a settled turn leaves kept background jobs alone', () => {
  it('a KUBIC_BASH_KEEP_BACKGROUND job of a completed turn survives /quit', async () => {
    vi.stubEnv('KUBIC_BASH_KEEP_BACKGROUND', '1');
    const h = harness([
      [
        fauxToolCall('bash', {
          command: 'sleep 30 >/dev/null 2>&1 & echo $! > bg.txt',
        }),
      ],
      'done',
    ]);
    // The runner records the turn only after it settled it, so the wrapped
    // `recordTurn` is the deterministic "turn finished" signal.
    let recorded = false;
    const inner = h.bootLane;
    h.bootLane = async (sessionId, answer, flags) => {
      const boot = await inner(sessionId, answer, flags);
      const loop = boot.loop;
      if (loop === undefined) throw new Error('the prod boot returned no loop');
      return {
        ...boot,
        loop: {
          ...loop,
          recordTurn: async (turn) => {
            await loop.recordTurn?.(turn);
            recorded = true;
          },
        },
      };
    };
    const { fake, exit } = start(h);
    await submit(fake, 'start a server');
    await waitFor(() => recorded);
    const bgFile = join(h.workspace, 'bg.txt');
    expect(existsSync(bgFile)).toBe(true);
    const bg = Number(readFileSync(bgFile, 'utf8').trim());
    pids.push(bg);
    expect(alive(bg)).toBe(true);
    fake.feed('\x1b'); // Esc quits while idle: nothing is in flight
    expect(await exit).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(bg)).toBe(true);
  });
});
