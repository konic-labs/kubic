// The `kubic tui` prompt loop over the lane: a prompt is accepted and driven,
// lane events reach the views, and the header facts and the turn receipt
// follow the live session. This file never imports @kubic/tui (dep-lint):
// the fake terminal satisfies the seam structurally, and the assertions read
// the restored main-screen document the loop prints. A real faux lane end to
// end: no network, no paid tokens.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootLane, type Lane } from '@kubic/agent/lane/boot';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tuiLoop } from '../../src/tui/lane-loop.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';

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

function sessionLogIncludes(root: string, needle: string): boolean {
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' }))
    if (
      entry.endsWith('.jsonl') &&
      readFileSync(join(root, entry), 'utf8').includes(needle)
    )
      return true;
  return false;
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
  it('drives a faux prompt end-to-end into the transcript view', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels(['all done, boss']);
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
    for (const ch of 'say done') fake.feed(ch);
    fake.feed('\r');
    // The live alt-screen frame carries the assistant text: the transcript
    // view received the lane's committed entries.
    await waitFor(() => fake.writes.join('').includes('all done, boss'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('▌ say done');
    expect(doc).toContain('all done, boss');
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
  });

  it('feeds tool calls into the tree and usage rows into the status bar', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      [fauxText('reading'), fauxToolCall('bash', { command: 'echo hi' })],
      'tool turn done',
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
    for (const ch of 'run it') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('tool turn done'));
    // The tree row opens on Ctrl-T; `/session` reports the
    // usage rows the status bar holds.
    fake.feed('\x14');
    for (const ch of '/session') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => /in [1-9]\d* out [1-9]\d*/.test(fake.writes.join('')));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    // The tree reflects the tool call: the runner's sink folds the event into
    // the projector and the app applies the state, so the tree's
    // snapshot path has a production caller. Asserted on the TREE's own
    // rendering — the glyph + name + args + duration line ('✓ bash echo hi
    // 1ms') that only TreeView produces (the transcript writes 'tool
    // bash', with no glyph and no duration), so dropping the projector fold or
    // the `applyPresentation` call in the sink turns this red.
    expect(doc).toMatch(/✓ bash echo hi \d+ms/);
    // The status bar carries a real usage row: setUsage has a production
    // caller too. The row values come from the lane's usage event, so a
    // dropped `setUsage` call must also turn this red (verified).
    expect(doc).toMatch(/in [1-9]\d* out [1-9]\d*/);
  });

  it('surfaces a refused abort as a footer, never an unhandled rejection', async () => {
    // TuiTurnRunner.cancel() must not await requestLaneAbort unguarded: that call
    // THROWS LaneDriveError when the lane refuses (lane/abort.ts:59), and the key
    // path must not `void turn.cancel().then(...)` without a catch, or a refusal
    // escapes as an unhandledRejection (example:
    // "lane abort failed for <id>: {\"message\":\"lane refuses abort\"}") and
    // the operator sees nothing happen at all.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted: () => void = () => {};
    const landed = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const { models } = fauxModels([
      async () => {
        // The model runs only after the lane ADMITTED the prompt, so waiting
        // here proves the abort below takes the in-flight path (admitted,
        // operationId set) rather than the latched pre-admission path — the
        // two have different catches and only the former was the bug.
        admitted();
        await gated;
        return fauxAssistantMessage('done');
      },
    ]);
    const base = fauxLaneBoot(root, models);
    const bootLane: TuiRunDeps['bootLane'] = async (sessionId?: string) => {
      const booted = await base(sessionId);
      const loop = booted.loop;
      if (loop === undefined) throw new Error('faux boot returned no loop');
      return {
        sessionId: booted.sessionId,
        model: booted.model,
        loop: {
          ...loop,
          // The lane refuses every abort request — the refusal case
          // (the real abortLane aggregates it into this named error).
          abort: async () => {
            throw new Error('lane abort failed: lane refuses abort');
          },
        },
      };
    };
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane,
      },
    );
    try {
      await waitFor(() => fake.counts.started === 1);
      for (const ch of 'stuck') fake.feed(ch);
      fake.feed('\r');
      // Wait for the lane to ADMIT before cancelling: this is the in-flight
      // path where the abort is issued against a live operationId.
      await landed;
      fake.feed('\x03'); // cancel: the lane will refuse
      // The refusal is REPORTED — either by the cancel path's own catch or by
      // the turn's failure path; either way the operator sees the named
      // reason instead of nothing happening. Asserting the stable prefix
      // only: the footer is width-clamped, so the trailing JSON detail is
      // truncated on a 100-column screen.
      await waitFor(() => fake.writes.join('').includes('lane abort failed'));
      expect(fake.counts.stopped).toBe(0);
      release();
      fake.feed('\x03'); // idle again: Ctrl-C quits
      fake.feed('\x03');
      expect((await pending).exitCode).toBe(0);
      // The released turn keeps settling in the background after the loop
      // quits; wait for its result to reach the session log so afterEach's
      // rmSync is not raced by a late append that recreates the temp root.
      await waitFor(() => sessionLogIncludes(root, '"kind":"pi.assistant"'));
      // After settlement, not after a fixed sleep: a 50 ms
      // nap lets the assertion pass when the rejection simply arrives
      // later. The log wait above is the turn's settlement signal.
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('cancels the in-flight turn on Ctrl-C without killing the process', async () => {
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
    // Ctrl-C while the turn is in flight — sent immediately after Enter, the
    // worst case (the lane may not have admitted the prompt yet). It must
    // cancel, not quit: the process stays alive and the screen is untouched.
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    expect(fake.counts.stopped).toBe(0);
    release();
    // The cancellation reached the lane: the aborted operation settles with
    // status 'aborted' and the loop reports it as cancelled — not completed.
    await waitFor(() => fake.writes.join('').includes('cancelled'));
    expect(fake.counts.stopped).toBe(0);
    expect(fake.writes.join('')).not.toContain('never delivered');
    // Now idle: Ctrl-C quits, restoring the main screen exactly once.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
  });

  it('queues a second Enter during a busy turn and delivers it after settlement', async () => {
    // Acceptance: the busy Enter is not dropped. It is admitted into
    // the conversation's OWN inbox (pi-durable `whenBusy: 'followUp'`), the
    // frame shows a dim `queued:` row, and the harness delivers the prompt
    // after the running turn settles — its own user entry and answer, on the
    // same settlement path as any other submit.
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
      'second answer',
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
    // The turn is in flight (the model is gated): the second Enter is
    // admitted to the inbox, never refused and never dropped.
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('queued: second prompt'));
    expect(calls()).toBe(1);
    release();
    await waitFor(() => fake.writes.join('').includes('second answer'));
    // The frame that carries the second answer is a frame AFTER placement:
    // the queued row is gone, the prompt's own echo/entry took over.
    const answered = fake.writes.filter((w) => w.includes('second answer'));
    expect(answered.at(-1) ?? '').not.toContain('queued: second prompt');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    // Both prompts are in the transcript, and the model ran twice: the
    // queued follow-up really was delivered after settlement.
    expect(doc).toContain('▌ first prompt');
    expect(doc).toContain('▌ second prompt');
    expect(calls()).toBe(2);
  });

  it('queues a follow-up in the session a /new rebuilt', async () => {
    // `/new` rebinds the lane and rebuilds the drivers, so the rebuilt runner
    // needs the loop's in-place queue map too: its projector otherwise keeps
    // its own empty map, resolves every inbox id to nothing and never renders
    // the row. The tests above only ever drive the initial runner.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { models, calls } = fauxModels([
      'first answer',
      async () => {
        await gated;
        return fauxAssistantMessage('second answer');
      },
      'third answer',
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
    const send = (text: string): void => {
      for (const ch of text) fake.feed(ch);
      fake.feed('\r');
    };
    send('first prompt');
    await waitFor(() => fake.writes.join('').includes('first answer'));
    // A fresh session: the lane is rebound and the runner rebuilt.
    fake.feed('\x15');
    send('/new');
    await waitFor(() => fake.writes.join('').includes('(new)'));
    // The fresh session's first turn is gated (busy), so the next Enter is
    // admitted to ITS inbox.
    send('second prompt');
    await waitFor(() => fake.writes.join('').includes('second prompt'));
    send('third prompt');
    await waitFor(() => fake.writes.join('').includes('queued: third prompt'));
    release();
    await waitFor(() => fake.writes.join('').includes('third answer'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(calls()).toBe(3);
  });

  it('Alt+Enter steers the running turn through the harness steer queue', async () => {
    // Acceptance: the steer key is not a queued follow-up. The text
    // goes to pi-durable with `whenBusy: 'steer'`, which places it after the
    // current tool round — so the model request that follows the tool round
    // carries it, inside the SAME turn.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const { models } = fauxModels([
      async () => {
        await gated;
        return fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'echo hi' })],
          { stopReason: 'toolUse' },
        );
      },
      (context) => {
        seen.push(
          context.messages.map((message) => JSON.stringify(message)).join('\n'),
        );
        return fauxAssistantMessage('steered answer');
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
    // The turn is in flight: Alt+Enter hands the draft to the lane as a
    // steer. Legacy encoding — the fake terminal does not negotiate Kitty.
    for (const ch of 'use pnpm') fake.feed(ch);
    fake.feed('\x1b\r');
    release();
    await waitFor(() => fake.writes.join('').includes('steered answer'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('use pnpm');
    // A steer is not a queued follow-up: no queued row was ever drawn.
    expect(fake.writes.join('')).not.toContain('queued: use pnpm');
  });

  it('an empty Enter during a busy turn is a no-op with no queue entry', async () => {
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
      'second answer',
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
    // The draft is empty: Enter is a no-op — no queued row, no render
    // change, and (after settlement) no second model request.
    const frames = fake.writes.length;
    fake.feed('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.writes.slice(frames).join('')).not.toContain('queued:');
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(calls()).toBe(1);
  });

  it('cancelling a busy turn clears the queued follow-ups and names the count', async () => {
    // The documented cancel rule: Esc/Ctrl-C aborts the running turn, and
    // pi-durable's abort withdraws every queued input with it — the footer
    // says how many prompts went, so nothing vanishes silently.
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
        return fauxAssistantMessage('never delivered');
      },
      'queued answer',
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
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('queued: second prompt'));
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('cancelling'));
    // The provider ignores cancellation until released; the abort then
    // settles the running turn AND withdraws the queued follow-up.
    release();
    await waitFor(() =>
      fake.writes.join('').includes('dropped 1 queued prompt'),
    );
    expect(fake.writes.join('')).not.toContain('queued answer');
    expect(calls()).toBe(1);
    // The session is alive and idle again: a second Ctrl-C quits.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('runs /compact [instructions] as a compaction, never as a prompt', async () => {
    // Acceptance: the command never reaches the model as text. The
    // lane admits Pi's manual compaction task with the focus as the
    // summarizer's instructions, exactly one `pi.compaction` entry lands, and
    // the footer reports what the cut did.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const seen: string[] = [];
    let lane: Lane | undefined;
    const { models, calls } = fauxModels([
      'first answer',
      'second answer',
      (context) => {
        seen.push(
          context.messages.map((message) => JSON.stringify(message)).join('\n'),
        );
        return fauxAssistantMessage('## Goal\nsummarized');
      },
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        // A test-sized keep-recent window: one 500-token turn is enough to
        // have something to cut (the shipped default is 20000).
        bootLane: fauxLaneBoot(root, models, {
          compaction: { keepRecentTokens: 200 },
          onBoot: (booted) => {
            lane = booted;
          },
        }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'first prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('first answer'));
    // Two turns: the first is older history. A session of one turn is only
    // its most recent turn, and there is nothing older to compact.
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('second answer'));
    for (const ch of '/compact focus on the auth bug') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      /compacted: \d+ tokens → summary/.test(fake.writes.join('')),
    );
    // The session is read while it is still open: quitting closes the lane.
    if (lane === undefined) throw new Error('the lane never booted');
    const page = await lane.conversation.entries(
      {},
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const entries = page.items;
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    // The summarizer saw the operator's instructions (and the agent turn
    // never saw the command text).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('focus on the auth bug');
    // Two agent turns and the one summary request.
    expect(calls()).toBe(3);
    expect(entries.filter((entry) => CompactionEntry.is(entry))).toHaveLength(
      1,
    );
    // No user message carries the command: it was a lane operation.
    const users = entries.filter((entry) => entry.kind === 'pi.user');
    expect(users.length).toBeGreaterThan(0);
    expect(JSON.stringify(users)).not.toContain('/compact');
    // The committed compaction entry reaches the transcript as
    // its own marker cell with the summary — the whole production wire
    // (laneEntryFor → entriesToCells → the render) in one assertion, so a
    // dropped join cannot stay green.
    const document = lines.join('\n');
    expect(document).toMatch(/─+ compacted(?: · \w+)? ─+/);
    expect(document).toContain('## Goal');
  });
});
