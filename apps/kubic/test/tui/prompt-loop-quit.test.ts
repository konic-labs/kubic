// The `kubic tui` prompt loop over the lane: a prompt is accepted and driven,
// lane events reach the views, and the header facts and the turn receipt
// follow the live session. This file never imports @kubic/tui (dep-lint):
// the fake terminal satisfies the seam structurally, and the assertions read
// the restored main-screen document the loop prints. A real faux lane end to
// end: no network, no paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootLane, type Lane } from '@kubic/agent/lane/boot';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  ConversationBusy,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import {
  bootFauxLane,
  fauxToolUse,
} from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { TUI_CLOCK_TICK_MS } from '../../src/tui/chrome.js';
import { tuiLoop } from '../../src/tui/lane-loop.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';
import { TuiTurnRunner } from '../../src/tui/turn-runner.js';

type FauxContent = Parameters<typeof fauxAssistantMessage>[0];

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

// A scripted response, or a factory that reads the request the harness
// built — the steer test asserts on the messages the model really saw.
type FauxStep =
  | FauxContent
  | (() => Promise<FauxMessage>)
  | ((context: { messages: readonly unknown[] }) => FauxMessage);

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-loop-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fauxModels(steps: FauxStep[]): {
  models: MutableModels;
  setResponses: (next: FauxStep[]) => void;
  calls: () => number;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const setResponses = (next: FauxStep[]): void => {
    faux.setResponses(
      next.map((step) => {
        if (typeof step === 'function') return step;
        // A message carrying a tool call must say so (pi-durable dispatches
        // the calls of a `toolUse` turn).
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
  };
  setResponses(steps);
  return { models, setResponses, calls: () => faux.state.callCount };
}

// A real lane boot against a temp sessions root with the faux provider —
// the prod boot shape (bootTuiLane) with the sessions root and models
// injected, exactly like `runHeadlessPrompt` accepts its deps.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
  options: {
    // A smaller keep-recent window lets a test-sized context compact.
    compaction?: Parameters<typeof bootLane>[0]['compaction'];
    // Boot-time harness settings (retry off, so a scripted
    // provider error fails the turn deterministically).
    settings?: Parameters<typeof bootLane>[0]['settings'];
    // The booted lane, for tests that read its transcript (the /compact
    // acceptance counts pi.compaction entries).
    onBoot?: (lane: Lane) => void;
    // Hand the session journal to the TUI (its panels and the
    // turn receipt read it).
    exposeJournal?: boolean;
  } = {},
): TuiRunDeps['bootLane'] {
  return async (sessionId?: string) => {
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const context = BACKGROUND_CONTEXT;
    const session = await createSession(store, { cwd: root }, context);
    const id = sessionId ?? session.id;
    bridge.createDir(join(id, 'journal'));
    const provider = models.getProviders()[0];
    if (provider === undefined) throw new Error('no provider registered');
    const model = models.getModels(provider.id)[0];
    if (model === undefined) throw new Error('no model registered');
    const journal = new FileJournalStore(join(root, id, 'journal'));
    const lane = await bootLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
      sessionId: id,
      agentId: 'root',
      journal,
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    });
    options.onBoot?.(lane);
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
      ...(options.exposeJournal === true ? { journal } : {}),
      loop: tuiLoop(lane),
      close: async () => {
        await lane.close(context);
        await session.release(context);
      },
    };
  };
}

function fakeTerminal(
  width: number,
  onStart?: (input: (data: string) => void) => void,
) {
  return terminalRig(width, 30, { onStart });
}

async function waitFor(
  condition: () => boolean,
  deadlineMs = 10_000,
): Promise<void> {
  // Deadline-based: a tick count is a latency assertion in
  // disguise — under contention 500 × 2 ms lapses before the frame lands.
  // A generous deadline only fails a true hang, never a slow scheduler.
  const start = Date.now();
  while (!condition() && Date.now() - start < deadlineMs) {
    // A real tick, not just a microtask: the alt-screen throttles renders,
    // so a frame can land a few milliseconds after the state change.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('kubic tui prompt loop', () => {
  it('refuses the side-effecting commands while a turn runs', async () => {
    // `/new`, `/resume` and `/undo` swap or close the session (and touch the
    // workspace) — a turn in flight owns both. The local reads stay allowed.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { models, calls } = fauxModels([
      async () => {
        await gated;
        return fauxAssistantMessage('first answer');
      },
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'first prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('first prompt'));
    const run = (command: string): void => {
      fake.feed('\x15');
      for (const ch of command) fake.feed(ch);
      fake.feed('\r');
    };
    for (const command of ['/new', '/resume', '/undo']) {
      const mark = fake.writes.length;
      run(command);
      await waitFor(() =>
        fake.writes
          .slice(mark)
          .join('')
          .includes('finish the current turn before switching'),
      );
    }
    // The reads still answer while the turn runs.
    run('/session');
    await waitFor(() => fake.writes.join('').includes('in 0 out 0 (cached 0)'));
    run('/help');
    await waitFor(() => fake.writes.join('').includes('help: 19 commands'));
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(calls()).toBe(1);
  });

  it('runs a command from the Ctrl-P palette', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models, calls } = fauxModels(['never used']);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // Ctrl-P (0x10) opens the palette: the registry's rows, descriptions
    // included.
    fake.feed('\x10');
    await waitFor(() => fake.writes.join('').includes('list the commands'));
    expect(fake.writes.join('')).toContain('/session');
    // Enter takes the first row: /help runs exactly as if it were typed.
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('help: 19 commands'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(calls()).toBe(0);
  });

  it('a durably busy conversation refuses the second turn with the busy failure', async () => {
    // The runner-level half of the busy contract, with the UI's own
    // submit guard bypassed on purpose: one turn is live on a REAL booted
    // lane, and the second submit is rejected by pi-durable (whenBusy
    // 'reject') — lane/turn.ts maps that to the named busy failure, which
    // the footer shows and which never reaches the model.
    const root = tmpRoot();
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lane = await bootFauxLane({
      storage: 'jsonl',
      root,
      responses: [
        async () => {
          await gated;
          return fauxAssistantMessage('first answer');
        },
        fauxAssistantMessage('second answer'),
      ],
    });
    try {
      const app = {
        applyLaneEntries: () => {},
        // The runner folds events through its projector and hands
        // the app the resulting state.
        applyPresentation: () => {},
        setUsage: () => {},
        presentationSeed: () => ({
          sessionId: 'sess-1',
          model: 'faux/faux-1',
          approvalsSkipped: false,
        }),
      } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
      const runner = new TuiTurnRunner(app, tuiLoop(lane.lane), 'faux/faux-1');
      const first = lane.run('first prompt');
      // The run is live: its model request has started.
      await waitFor(() => lane.faux.state.callCount === 1);
      const refused = await runner.run('second prompt');
      expect(refused.status).toBe('failed');
      expect(refused.detail).toContain('lane refused the prompt');
      expect(lane.faux.state.callCount).toBe(1);
      // The durable fact behind the footer text: the submit is rejected by
      // pi-durable, not queued (lane/turn.ts's mapping of it is pinned
      // by lane/turn.test.ts).
      await expect(
        lane.lane.conversation.submit(
          { type: 'input', content: 'second prompt', whenBusy: 'reject' },
          BACKGROUND_CONTEXT,
        ),
      ).rejects.toThrow(ConversationBusy);
      release();
      expect((await first).status).toBe('completed');
      expect(lane.faux.state.callCount).toBe(1);
    } finally {
      await lane.cleanup();
    }
  });

  it('quits on the Kitty-protocol form of Ctrl-C and Ctrl-D, not only legacy bytes', async () => {
    // The loop must not compare raw input against legacy control bytes alone,
    // so a Kitty-class terminal — which
    // sends CSI-u sequences ('\x1b[99;5u' for Ctrl-C, '\x1b[100;5u' for
    // Ctrl-D) must not hit the fall-through branch and do nothing: `consumed: true`
    // with no effect, the exact silent no-op key the criterion forbids. Esc
    // ('\x1b[27u') does not quit at all; Ctrl-C quits on its
    // double press.
    for (const presses of [['\x1b[99;5u', '\x1b[99;5u'], ['\x1b[100;5u']]) {
      const root = tmpRoot();
      const lines: string[] = [];
      const fake = fakeTerminal(100);
      const { models } = fauxModels(['hello']);
      const pending = runTuiCommand(
        {},
        {
          out: (line: string) => lines.push(line),
          createTerminal: () => fake.terminal,
          colorLevel: 'none',
          bootLane: fauxLaneBoot(root, models),
        },
      );
      await waitFor(() => fake.counts.started === 1);
      for (const press of presses) fake.feed(press);
      expect((await pending).exitCode).toBe(0);
      expect(fake.counts.stopped).toBe(1);
    }
  });

  it('quits on a second Ctrl-C during a turn, matching the documented key table', async () => {
    // docs/cli/commands.md ships: "Ctrl-C | Cancel the in-flight turn; while
    // idle, quit. A second Ctrl-C during a turn also quits." The second one
    // arrives while the cancellation is still draining — the turn is no
    // longer "running" but the abort has not settled. That must quit.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { models } = fauxModels([
      async () => {
        await gated;
        return fauxAssistantMessage('never delivered');
      },
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'slow two') fake.feed(ch);
    fake.feed('\r');
    // First Ctrl-C cancels (process stays alive).
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    expect(fake.counts.stopped).toBe(0);
    // Second Ctrl-C while the cancel is still draining quits.
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    release();
  });

  it('quits on stdin EOF so a detached tty cannot hang the alt-screen', async () => {
    // EOF is defined behaviour, not a silent no-op. Pi's
    // terminal exposes no EOF callback, so the loop watches the stream itself.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    process.stdin.emit('end');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    // The listener is removed with the screen: a second EOF is inert and
    // the process holds no dangling handler on the real stream.
    process.stdin.emit('end');
    expect(fake.counts.stopped).toBe(1);
  });

  it('Esc interrupts a busy turn and never quits', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { models } = fauxModels([
      async () => {
        await gated;
        return fauxAssistantMessage('never delivered');
      },
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'slow one') fake.feed(ch);
    fake.feed('\r');
    // Busy: Esc interrupts, like the first Ctrl-C.
    fake.feed('\x1b');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    // A second Esc while the interrupt drains is not a quit.
    fake.feed('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.counts.stopped).toBe(0);
    release();
    await waitFor(() => fake.writes.join('').includes('cancelled'));
    expect(fake.counts.stopped).toBe(0);
    // Idle, empty editor: Esc is still not a quit — it enters block mode, and a
    // second Esc returns to typing.
    fake.feed('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x1b');
    // Idle with a draft: Esc keeps it.
    for (const ch of 'keep me') fake.feed(ch);
    fake.feed('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.counts.stopped).toBe(0);
    expect(fake.writes.join('')).toContain('keep me');
    // Ctrl-C clears the draft, then the double press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('quits on Ctrl-D and on a Ctrl-C double press with an empty draft', async () => {
    for (const key of ['\x04', '\x03\x03']) {
      const root = tmpRoot();
      const lines: string[] = [];
      const fake = fakeTerminal(100);
      const { models } = fauxModels([]);
      const pending = runTuiCommand(
        {},
        {
          out: (line: string) => lines.push(line),
          createTerminal: () => fake.terminal,
          colorLevel: 'none',
          bootLane: fauxLaneBoot(root, models),
        },
      );
      await waitFor(() => fake.counts.started === 1);
      for (const press of key) fake.feed(press);
      expect((await pending).exitCode).toBe(0);
      expect(fake.counts.stopped).toBe(1);
      expect(lines.join('\n')).toContain('approvals on');
    }
  });

  it('prints the final document with the prompt in it', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels(['answered']);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'a question') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('answered'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    // The header above the transcript, the status line below.
    const order = ['approvals on', '▌ a question', 'answered', ' ready '].map(
      (marker) => doc.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The committed prompt carries its time through the whole
    // production wire (laneEntryFor → entriesToCells → the prompt block).
    expect(doc).toMatch(/▌ a question +you · \d\d:\d\d:\d\d/);
  });
});

// The header's live facts — the workspace the composition root
// reads (at boot and after every settled turn) and the wall clock.
describe('the header facts on the live loop', () => {
  it('reads the workspace at boot and again after a settled turn', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(120);
    const { models } = fauxModels(['first done']);
    let reads = 0;
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models),
        readWorkspace: async () => {
          reads += 1;
          return { project: 'playground', branch: 'main', dirty: reads };
        },
      },
    );
    await waitFor(() =>
      fake.writes.join('').includes('│ playground  ⎇ main ●1'),
    );
    for (const ch of 'go') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('first done'));
    await waitFor(() => fake.writes.join('').includes('⎇ main ●2'));
    expect(reads).toBe(2);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  it('repaints the clock only when its minute changes, and stops it on quit', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let now = new Date(2026, 9, 6, 9, 59, 10);
      const fake = fakeTerminal(120);
      const pending = runTuiCommand(
        {},
        {
          out: () => {},
          createTerminal: () => fake.terminal,
          colorLevel: 'none',
          bootLane: async (sessionId?: string) => ({
            sessionId: sessionId ?? 's1',
            model: 'faux/test',
          }),
          clock: () => now,
        },
      );
      await waitFor(() => fake.writes.join('').includes('│ 09:59 '));
      // Let the boot frames settle, then tick within the same minute.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const mark = fake.writes.length;
      now = new Date(2026, 9, 6, 9, 59, 40);
      vi.advanceTimersByTime(TUI_CLOCK_TICK_MS);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.writes.length).toBe(mark);
      now = new Date(2026, 9, 6, 10, 0, 5);
      vi.advanceTimersByTime(TUI_CLOCK_TICK_MS);
      await waitFor(() =>
        fake.writes.slice(mark).join('').includes('│ 10:00 '),
      );
      fake.feed('\x03');
      fake.feed('\x03');
      expect((await pending).exitCode).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Every settled turn ends with its receipt — the
// whole production wire: the turn's tool call, the journal row its write
// recorded, and the receipt the settlement appends.
describe('the turn receipt on the live loop', () => {
  it('counts the tools, the file and its lines of a write turn', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(120);
    const { models } = fauxModels([
      [
        fauxText('writing'),
        fauxToolCall('write', { path: 'notes.md', content: 'one\ntwo\n' }),
      ],
      'written',
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models, { exposeJournal: true }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'write the notes') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      /✓ turn \d+\.\ds · 1 tool · 1 file \+2 −0 · \$0\.000/.test(
        fake.writes.join(''),
      ),
    );
    fake.feed('\x04');
    expect((await pending).exitCode).toBe(0);
  });
});
