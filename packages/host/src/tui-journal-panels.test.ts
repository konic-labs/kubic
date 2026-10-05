// The §17 inspectable pair on the real `kubic tui` path (issue #311): the
// Ctrl-O diff panel and the Ctrl-R journal panel read the session journal
// (the same diffEntries projection `kubic diff` uses) instead of showing
// 'no changes' for the whole session.
//
// Real code end to end: the prod bootTuiLane re-rooted onto temp state, the
// real NodeExecutionEnv inside a temp workspace, a recording fake Terminal
// under the real alt-screen. Faux provider only: zero network.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  JournalPanelFeed,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import { fauxToolUse } from '../../worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-journal-'));
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

type Step = Parameters<typeof fauxAssistantMessage>[0];

function recordingTerminal() {
  return terminalRig(120, 40);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function prodBoot(
  sessionsRoot: string,
  workspace: string,
  steps: Step[],
): TuiRunDeps['bootLane'] {
  return (sessionId, answer) => {
    const faux = fauxProvider();
    faux.setResponses(
      steps.map((step) => {
        // pi-durable dispatches the calls of a `toolUse` turn.
        const toolUse =
          Array.isArray(step) &&
          step.some(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'toolCall',
          );
        return toolUse ? fauxToolUse(step) : fauxAssistantMessage(step);
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    return bootTuiLane(sessionId, {
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      ...(answer === undefined ? {} : { answer }),
    });
  };
}

async function openTui(
  sessionsRoot: string,
  workspace: string,
  steps: Step[],
  session?: string,
  extra: Partial<TuiRunDeps> = {},
) {
  const fake = recordingTerminal();
  const lines: string[] = [];
  const exit = runTuiCommand(session === undefined ? {} : { session }, {
    out: (line) => lines.push(line),
    createTerminal: () => fake.terminal,
    colorLevel: 'none',
    bootLane: prodBoot(sessionsRoot, workspace, steps),
    ...extra,
  });
  await waitFor(() => fake.counts.started === 1);
  return { fake, lines, exit };
}

async function submit(
  fake: ReturnType<typeof recordingTerminal>,
  prompt: string,
  settled: string,
): Promise<void> {
  for (const ch of prompt) fake.feed(ch);
  fake.feed('\r');
  await waitFor(() => fake.since(0).includes(settled));
  // Let the settlement's own journal read and frame land.
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('the Ctrl-O / Ctrl-R panels read the session journal (issue #311)', () => {
  it('after a write, Ctrl-O renders a hunk for the written path', async () => {
    const workspace = tmpRoot();
    const { fake, exit } = await openTui(tmpRoot(), workspace, [
      [fauxToolCall('write', { path: 'hello.txt', content: 'hi there\n' })],
      'wrote it',
    ]);
    await submit(fake, 'write hello', 'wrote it');
    const mark = fake.mark();
    fake.feed('\x0f');
    await waitFor(() => fake.since(mark).includes('hello.txt'));
    expect(fake.since(mark)).toContain('+hi there');
    expect(fake.since(mark)).not.toContain('no changes');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('the journal panel lists every change in the session', async () => {
    const workspace = tmpRoot();
    const { fake, exit } = await openTui(tmpRoot(), workspace, [
      [
        fauxToolCall('write', { path: 'alpha.txt', content: 'a\n' }),
        fauxToolCall('write', { path: 'beta.txt', content: 'b\n' }),
      ],
      'two files',
    ]);
    await submit(fake, 'write two', 'two files');
    const mark = fake.mark();
    fake.feed('\x12');
    await waitFor(
      () =>
        fake.since(mark).includes('alpha.txt') &&
        fake.since(mark).includes('beta.txt'),
    );
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('the diff panel follows the most recent tool call that has journal rows', async () => {
    const workspace = tmpRoot();
    const { fake, exit } = await openTui(tmpRoot(), workspace, [
      [fauxToolCall('write', { path: 'kept.txt', content: 'kept\n' })],
      // A read has no journal rows: the panel must not fall to 'no changes'.
      [fauxToolCall('read', { path: 'kept.txt' })],
      'read back',
    ]);
    await submit(fake, 'write then read', 'read back');
    const mark = fake.mark();
    fake.feed('\x0f');
    await waitFor(() => fake.since(mark).includes('kept.txt'));
    expect(fake.since(mark)).not.toContain('no changes');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  // Issue #311: a `bash` write is not intercepted by the file tools, so the
  // change reaches the journal only through the §42.5 sweep. It used to run
  // at quit alone, so both panels said `no changes` (Ctrl-O) / listed
  // nothing (Ctrl-R) for a change the user had just watched happen.
  it('a change made with bash shows in Ctrl-R and Ctrl-O when the turn settles, before any quit', async () => {
    const workspace = tmpRoot();
    const { fake, exit } = await openTui(tmpRoot(), workspace, [
      [
        fauxToolCall('bash', {
          command: "printf 'made by bash\\n' > shellfile.txt",
        }),
      ],
      'shell done',
    ]);
    await submit(fake, 'make a file', 'shell done');
    expect(readFileSync(join(workspace, 'shellfile.txt'), 'utf8')).toBe(
      'made by bash\n',
    );
    let mark = fake.mark();
    fake.feed('\x0f');
    await waitFor(() => fake.since(mark).includes('shellfile.txt'));
    expect(fake.since(mark)).toContain('made by bash');
    expect(fake.since(mark)).not.toContain('no changes');
    // Switching panels needs no Esc: Ctrl-R opens the journal listing.
    mark = fake.mark();
    fake.feed('\x12');
    await waitFor(() => fake.since(mark).includes('shellfile.txt'));
    // The journal listing is `kubic diff`'s text: the swept row is named as
    // what it is (unattributed: the sweep cannot know which call wrote it).
    expect(fake.since(mark)).toContain('+++ b/shellfile.txt');
    expect(fake.since(mark)).toContain('unattributed, non-reversible');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('the settlement sweep runs only after a turn that used the shell, once per such turn', async () => {
    const workspace = tmpRoot();
    let sweeps = 0;
    const fake = recordingTerminal();
    const steps: Step[] = [
      [fauxToolCall('write', { path: 'plain.txt', content: 'p\n' })],
      'wrote',
      [fauxToolCall('bash', { command: 'true' })],
      'ran shell',
      [fauxToolCall('write', { path: 'again.txt', content: 'q\n' })],
      'wrote again',
    ];
    const boot = prodBoot(tmpRoot(), workspace, steps);
    const exit = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId, answer) => {
          const real = await boot(sessionId, answer);
          const reconcile = real.reconcile;
          expect(reconcile).toBeDefined();
          return {
            ...real,
            reconcile: () => {
              sweeps += 1;
              reconcile?.();
            },
          };
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // A file-tool turn: journaled by the tool itself, nothing to sweep.
    await submit(fake, 'write plain', 'wrote');
    expect(sweeps).toBe(0);
    // A shell turn: swept exactly once at its settlement.
    await submit(fake, 'run the shell', 'ran shell');
    expect(sweeps).toBe(1);
    // The next file-tool turn does not inherit the shell flag.
    await submit(fake, 'write again', 'wrote again');
    expect(sweeps).toBe(1);
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('a failing sweep never reaches the loop: the turn still settles and the panels keep working', async () => {
    const workspace = tmpRoot();
    const fake = recordingTerminal();
    const boot = prodBoot(tmpRoot(), workspace, [
      [fauxToolCall('bash', { command: 'true' })],
      'shell done',
    ]);
    const exit = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId, answer) => ({
          ...(await boot(sessionId, answer)),
          reconcile: () => {
            throw new Error('sweep exploded');
          },
        }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    await submit(fake, 'run the shell', 'shell done');
    expect(fake.since(0)).not.toContain('sweep exploded');
    const mark = fake.mark();
    fake.feed('\x12');
    await waitFor(() => fake.since(mark).includes('no changes'));
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  // The tool-end wiring (issue #311): a tool that ends mid-turn asks the feed
  // for a (throttled) journal read, so the panels are current DURING a long
  // turn, not only at its settlement. Observed by counting the reads the
  // panel feed makes of the boot's journal store.
  it('a tool-end refreshes the panels while the turn is still running', async () => {
    const workspace = tmpRoot();
    const fake = recordingTerminal();
    let reads = 0;
    const boot = prodBoot(tmpRoot(), workspace, [
      [fauxToolCall('write', { path: 'early.txt', content: 'e\n' })],
      [fauxToolCall('bash', { command: 'sleep 1.5' })],
      'slept',
    ]);
    const exit = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId, answer) => {
          const real = await boot(sessionId, answer);
          const store = real.journal;
          if (store === undefined) throw new Error('no journal store');
          return {
            ...real,
            journal: new Proxy(store, {
              get: (target, prop) => {
                const value = Reflect.get(target, prop, target);
                if (prop === 'entries') {
                  return (...args: []) => {
                    reads += 1;
                    return target.entries(...args);
                  };
                }
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          };
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    const atBoot = reads;
    expect(atBoot).toBeGreaterThanOrEqual(1);
    for (const ch of 'write then sleep') fake.feed(ch);
    fake.feed('\r');
    // The write's tool-end schedules one read within the refresh window,
    // while the bash call is still sleeping.
    for (let i = 0; i < 700 && reads <= atBoot; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(reads).toBeGreaterThan(atBoot);
    expect(fake.since(0)).not.toContain('slept');
    await waitFor(() => fake.since(0).includes('slept'));
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  // Issue #311 review: `apply` reads `stopped` / `screen`, which used to be
  // declared AFTER the synchronous boot read — a TDZ ReferenceError on every
  // boot that the feed's catch swallowed. Nothing may be swallowed now.
  it('the feed swallows nothing at boot or at a settlement (no TDZ in the apply path)', async () => {
    const workspace = tmpRoot();
    const failures: unknown[] = [];
    const { fake, exit } = await openTui(
      tmpRoot(),
      workspace,
      [
        [fauxToolCall('write', { path: 'hello.txt', content: 'hi\n' })],
        'wrote it',
      ],
      undefined,
      { journalFeedError: (error) => failures.push(error) },
    );
    await submit(fake, 'write hello', 'wrote it');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
    expect(failures).toEqual([]);
  });

  it('resuming a session shows its earlier journal entries on the first Ctrl-R', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    const first = await prodBoot(sessionsRoot, workspace, ['unused'])();
    first.journal?.append({
      path: 'earlier.txt',
      op: 'create',
      before: null,
      after: 'from before\n',
      bytesDelta: 12,
      sessionId: first.sessionId,
      agentId: 'root',
      toolCallId: 'call-earlier',
      timestamp: Date.now(),
    });
    await first.close?.();
    const { fake, exit } = await openTui(
      sessionsRoot,
      workspace,
      ['unused'],
      first.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mark = fake.mark();
    fake.feed('\x12');
    await waitFor(() => fake.since(mark).includes('earlier.txt'));
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('journal rows are sanitized before they reach the panel', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    const first = await prodBoot(sessionsRoot, workspace, ['unused'])();
    const store = first.journal as FileJournalStore;
    store.append({
      path: 'evil\x1b[2Jname.txt',
      op: 'create',
      before: null,
      after: 'x\n',
      bytesDelta: 2,
      sessionId: first.sessionId,
      agentId: 'root',
      toolCallId: 'call-evil',
      timestamp: Date.now(),
    });
    await first.close?.();
    const { fake, exit } = await openTui(
      sessionsRoot,
      workspace,
      ['unused'],
      first.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mark = fake.mark();
    fake.feed('\x12');
    await waitFor(() => fake.since(mark).includes('name.txt'));
    expect(fake.since(mark)).not.toContain('evil\x1b[2J');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });
});

describe('JournalPanelFeed throttles journal reads (issue #311)', () => {
  it('a burst of 10 tool-end events reads the journal at most once per window', () => {
    let reads = 0;
    const applied: number[] = [];
    const timers: Array<() => void> = [];
    const feed = new JournalPanelFeed({
      read: () => {
        reads += 1;
        return [];
      },
      apply: () => {
        applied.push(reads);
      },
      schedule: (fn) => {
        timers.push(fn);
      },
    });
    for (let i = 0; i < 10; i += 1) feed.request();
    expect(reads).toBe(0);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(reads).toBe(1);
    // The next window opens only after the previous read ran.
    for (let i = 0; i < 10; i += 1) feed.request();
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(reads).toBe(2);
    expect(applied).toEqual([1, 2]);
  });

  it('now() reads at once and supersedes a pending window', () => {
    let reads = 0;
    const timers: Array<() => void> = [];
    const feed = new JournalPanelFeed({
      read: () => {
        reads += 1;
        return [];
      },
      apply: () => {},
      schedule: (fn) => {
        timers.push(fn);
      },
    });
    feed.request();
    feed.now();
    expect(reads).toBe(1);
    timers.shift()?.();
    // The superseded window does not read again.
    expect(reads).toBe(1);
  });

  it('a read failure never escapes the feed', () => {
    const feed = new JournalPanelFeed({
      read: () => {
        throw new Error('journal unreadable');
      },
      apply: () => {},
      schedule: (fn) => fn(),
    });
    expect(() => feed.request()).not.toThrow();
    expect(() => feed.now()).not.toThrow();
  });
});

// Issue #374 (§42.1): every prompt is a run. The sweep re-baselines at each
// turn start, so a file the operator edits between prompts is never
// journaled as the agent's change, sweep entries carry their turn, and the
// quit-time sweep after a settled turn appends nothing new.
describe('per-turn reconciliation in the TUI (issue #374)', () => {
  function sweptEntries(sessionsRoot: string) {
    const [id] = readdirSync(sessionsRoot).filter((e) => !e.startsWith('.'));
    if (id === undefined) return [];
    return new FileJournalStore(join(sessionsRoot, id, 'journal'))
      .entries()
      .filter((entry) => entry.unattributed === true);
  }

  it('an edit made between prompts is not attributed to the next turn; entries carry the turn', async () => {
    const workspace = tmpRoot();
    const sessionsRoot = tmpRoot();
    writeFileSync(join(workspace, 'mine.txt'), 'before\n');
    const { fake, exit } = await openTui(sessionsRoot, workspace, [
      [fauxToolCall('bash', { command: "printf 'one\\n' > one.txt" })],
      'turn one',
      [fauxToolCall('bash', { command: "printf 'two\\n' > two.txt" })],
      'turn two',
    ]);
    await submit(fake, 'first', 'turn one');
    await waitFor(() =>
      sweptEntries(sessionsRoot).some((entry) => entry.path === 'one.txt'),
    );
    // Out-of-band: the operator edits mine.txt between the two prompts.
    writeFileSync(join(workspace, 'mine.txt'), 'operator edit\n');
    await submit(fake, 'second', 'turn two');
    await waitFor(() =>
      sweptEntries(sessionsRoot).some((entry) => entry.path === 'two.txt'),
    );
    expect(
      sweptEntries(sessionsRoot).map((entry) => [entry.path, entry.turn]),
    ).toEqual([
      ['one.txt', 1],
      ['two.txt', 2],
    ]);
    fake.feed('\x1b');
    expect(await exit).toBe(0);
    expect(
      sweptEntries(sessionsRoot).some((entry) => entry.path === 'mine.txt'),
    ).toBe(false);
  });

  it('the quit-time sweep after a settled turn adds no duplicates and no post-turn edits', async () => {
    const workspace = tmpRoot();
    const sessionsRoot = tmpRoot();
    const { fake, exit } = await openTui(sessionsRoot, workspace, [
      [fauxToolCall('bash', { command: "printf 'x\\n' > made.txt" })],
      'made',
    ]);
    await submit(fake, 'make it', 'made');
    await waitFor(() => sweptEntries(sessionsRoot).length === 1);
    // An edit after the last turn settled, before the quit.
    writeFileSync(join(workspace, 'after.txt'), 'operator\n');
    fake.feed('\x1b');
    expect(await exit).toBe(0);
    expect(sweptEntries(sessionsRoot).map((entry) => entry.path)).toEqual([
      'made.txt',
    ]);
  });
});
