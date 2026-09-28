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
