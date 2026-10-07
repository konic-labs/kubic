// `kubic tui` prompt loop over the solo lane (issue #88).
// Before #88 runTuiCommand booted a viewer shell — no prompt accept, no
// drive, no lane events into the views, and Ctrl-C exited unconditionally.
//
// The tui entry lives in apps/kubic (the composition root: the only owner
// allowed to wire host + tui together), so this cross-cutting proof lives
// here next to tui-regression.test.ts and run-prod-path.test.ts. This file
// never imports @kubic/tui (dep-lint): the fake terminal satisfies the
// seam structurally and the assertions read the restored main-screen
// document the loop prints. One file drives a REAL faux lane end-to-end:
// no VirtualTerminal (it does not exist), no network, no paid tokens.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  bootSoloLane,
  type SoloLane,
} from '../../../packages/worker/src/lane/solo.js';
import {
  bootFauxLane,
  fauxToolUse,
} from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  ConversationBusy,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  runTuiCommand,
  soloTuiLoop,
  TUI_CLOCK_TICK_MS,
  TuiCompactionTurn,
  type TuiLaneLoop,
  type TuiRunDeps,
  TuiTurnRunner,
} from './tui-run.js';

type FauxContent = Parameters<typeof fauxAssistantMessage>[0];
type FauxMessage = ReturnType<typeof fauxAssistantMessage>;
// A scripted response, or a factory that reads the request the harness
// built — the #334 steer test asserts on the messages the model really saw.
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
        // the calls of a `toolUse` turn; 0.87 inferred them from the parts).
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

// A real solo boot against a temp sessions root with the faux provider —
// the prod boot shape (bootTuiLane) with the sessions root and models
// injected, exactly like headless-run.ts accepts its deps.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
  options: {
    // #330: a smaller keep-recent window lets a test-sized context compact.
    compaction?: Parameters<typeof bootSoloLane>[0]['compaction'];
    // #334 review: boot-time harness settings (retry off, so a scripted
    // provider error fails the turn deterministically).
    settings?: Parameters<typeof bootSoloLane>[0]['settings'];
    // The booted lane, for tests that read its transcript (the /compact
    // acceptance counts pi.compaction entries).
    onBoot?: (solo: SoloLane) => void;
    // Issue #457: hand the session journal to the TUI (its panels and the
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
    const solo = await bootSoloLane({
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
    options.onBoot?.(solo);
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
      ...(options.exposeJournal === true ? { journal } : {}),
      loop: soloTuiLoop(solo),
      close: async () => {
        await solo.close(context);
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
  // Deadline-based (issue #385): a tick count is a latency assertion in
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

describe('kubic tui prompt loop (issue #88)', () => {
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
    expect(await pending).toBe(0);
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
    // Issue #453: the solo tree row opens on Ctrl-T; `/session` reports the
    // usage rows the status bar holds.
    fake.feed('\x14');
    for (const ch of '/session') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => /in [1-9]\d* out [1-9]\d*/.test(fake.writes.join('')));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    // The tree reflects the tool call: the runner's sink folds the event into
    // the projector and the app applies the state (#333 §66), so the tree's
    // snapshot path has a production caller. Asserted on the TREE's own
    // rendering — the glyph + name + args + duration line ('✓ bash echo hi
    // 1ms') that only AgentTreeView produces (the transcript writes 'tool
    // bash', with no glyph and no duration), so dropping the projector fold or
    // the `applyPresentation` call in the sink turns this red.
    expect(doc).toMatch(/✓ bash echo hi \d+ms/);
    // The status bar carries a real usage row: setUsage has a production
    // caller too. The row values come from the lane's usage event, so a
    // dropped `setUsage` call must also turn this red (verified).
    expect(doc).toMatch(/in [1-9]\d* out [1-9]\d*/);
  });

  it('surfaces a refused abort as a footer, never an unhandled rejection', async () => {
    // RED before the fix: TuiTurnRunner.cancel() awaited requestLaneAbort,
    // which THROWS LaneDriveError when the lane refuses (lane/abort.ts:59),
    // and the key path did `void turn.cancel().then(...)` with no catch — so
    // a refusal escaped as an unhandledRejection (observed:
    // "lane abort failed for <id>: {\"message\":\"lane refuses abort\"}") and
    // the operator saw nothing happen at all.
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
          // The lane refuses every abort request — the reviewer's scenario
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
      expect(await pending).toBe(0);
      // The released turn keeps settling in the background after the loop
      // quits; wait for its result to reach the session log so afterEach's
      // rmSync is not raced by a late append that recreates the temp root.
      await waitFor(() => sessionLogIncludes(root, '"kind":"pi.assistant"'));
      // After settlement, not after a fixed sleep (issue #385): a 50 ms
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
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
  });

  it('queues a second Enter during a busy turn and delivers it after settlement (#334)', async () => {
    // Acceptance (#334): the busy Enter is not dropped. It is admitted into
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    // Both prompts are in the transcript, and the model ran twice: the
    // queued follow-up really was delivered after settlement.
    expect(doc).toContain('▌ first prompt');
    expect(doc).toContain('▌ second prompt');
    expect(calls()).toBe(2);
  });

  it('queues a follow-up in the session a /new rebuilt (#333 review)', async () => {
    // `/new` rebinds the lane and rebuilds the drivers, so the rebuilt runner
    // needs the loop's in-place queue map too: its projector otherwise keeps
    // its own empty map, resolves every inbox id to nothing and never renders
    // the row. The #334 tests above only ever drive the initial runner.
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
    expect(await pending).toBe(0);
    expect(calls()).toBe(3);
  });

  it('Alt+Enter steers the running turn through the harness steer queue (#334)', async () => {
    // Acceptance (#334): the steer key is not a queued follow-up. The text
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
    expect(await pending).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('use pnpm');
    // A steer is not a queued follow-up: no queued row was ever drawn.
    expect(fake.writes.join('')).not.toContain('queued: use pnpm');
  });

  it('an empty Enter during a busy turn is a no-op with no queue entry (#334)', async () => {
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
    expect(await pending).toBe(0);
    expect(calls()).toBe(1);
  });

  it('cancelling a busy turn clears the queued follow-ups and names the count (#334)', async () => {
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
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('runs /compact [instructions] as a compaction, never as a prompt (#330)', async () => {
    // Acceptance (#330): the command never reaches the model as text. The
    // lane admits Pi's manual compaction task with the focus as the
    // summarizer's instructions, exactly one `pi.compaction` entry lands, and
    // the footer reports what the cut did.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const seen: string[] = [];
    let lane: SoloLane | undefined;
    const { models, calls } = fauxModels([
      'first answer',
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
    expect(await pending).toBe(0);
    // The summarizer saw the operator's instructions (and the agent turn
    // never saw the command text).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('focus on the auth bug');
    expect(calls()).toBe(2);
    expect(entries.filter((entry) => CompactionEntry.is(entry))).toHaveLength(
      1,
    );
    // No user message carries the command: it was a lane operation.
    const users = entries.filter((entry) => entry.kind === 'pi.user');
    expect(users.length).toBeGreaterThan(0);
    expect(JSON.stringify(users)).not.toContain('/compact');
    // Issue #317: the committed compaction entry reaches the transcript as
    // its own marker cell with the summary — the whole production wire
    // (laneEntryFor → entriesToCells → the render) in one assertion, so a
    // dropped join cannot stay green.
    const document = lines.join('\n');
    expect(document).toMatch(/─+ compacted(?: · \w+)? ─+/);
    expect(document).toContain('## Goal');
  });

  it('refuses /compact while a turn runs, with the reason on the footer (#330)', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lane: SoloLane | undefined;
    const { models } = fauxModels([
      async () => {
        await gated;
        return fauxAssistantMessage('first answer');
      },
      '## Goal\nsummarized',
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
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
    await waitFor(() => fake.writes.join('').includes('first prompt'));
    for (const ch of '/compact') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('compact: finish the current turn before compacting'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    if (lane === undefined) throw new Error('the lane never booted');
    const page = await lane.conversation.entries(
      {},
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(
      page.items.filter((entry) => CompactionEntry.is(entry)),
    ).toHaveLength(0);
    // Issue #302: with a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it (#454).
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('cancels a running compaction with Ctrl-C and says so (#330)', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let releaseSummary: () => void = () => {};
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      summaryStarted = resolve;
    });
    const { models } = fauxModels([
      'first answer',
      async () => {
        summaryStarted();
        await summaryGate;
        return fauxAssistantMessage('## Goal\nsummarized');
      },
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models, {
          compaction: { keepRecentTokens: 200 },
        }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'first prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('first answer'));
    for (const ch of '/compact') fake.feed(ch);
    fake.feed('\r');
    // The compaction task is live (its summarization request is gated):
    // Ctrl-C aborts the conversation and Pi settles the task aborted.
    await started;
    fake.feed('\x03');
    releaseSummary();
    await waitFor(() => fake.writes.join('').includes('compaction cancelled'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('keeps the draft when a submit is refused (#334 review)', async () => {
    // A refused prompt must never eat the text: the editor is live during a
    // turn (#334), so `/model` while busy hands the draft back instead of
    // clearing it.
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
    for (const ch of '/model faux/other') fake.feed(ch);
    const refusedAt = fake.writes.length;
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('model: finish the current turn before switching'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    // Issue #302: with a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it (#454).
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // Issue #302: the frames drawn after the Enter carry the draft (the
    // typing that preceded the clear is outside the slice, so this proves
    // the restore rather than the input).
    expect(fake.writes.slice(refusedAt).join('')).toContain(
      '/model faux/other',
    );
  });

  it('keeps the draft when a steer is refused (#334 review)', async () => {
    // The Alt+Enter path clears the editor before the loop decides; a refusal
    // (a model command sent as a steer) must put it back too.
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
    for (const ch of '/model faux/other') fake.feed(ch);
    const refusedAt = fake.writes.length;
    fake.feed('\x1b\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('model: finish the current turn before switching'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    // Issue #302: with a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it (#454).
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.writes.slice(refusedAt).join('')).toContain(
      '/model faux/other',
    );
  });

  it('releases the busy latch when a failed run leaves a queued follow-up (#334 review)', async () => {
    // pi-durable keeps queued inputs when a run faults. The waiting follow-up
    // is not work in flight: the spinner must stop, the queued row stays, and
    // the next submit places the queue (oldest first) and runs it.
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
        return fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'provider exploded',
        });
      },
      'second answer',
      'third answer',
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models, {
          // Retry off: the scripted provider error fails the turn at once.
          settings: { retry: { enabled: false } },
        }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'first prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('first prompt'));
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('queued: second prompt'));
    release();
    // The turn failed and the follow-up stayed queued in the inbox.
    await waitFor(() => fake.writes.join('').includes('error:'));
    expect(calls()).toBe(1);
    expect(fake.writes.join('')).toContain('queued: second prompt');
    // The next submit places the queue: the waiting follow-up runs first,
    // and the new prompt follows it (oldest first, one per boundary).
    for (const ch of 'third prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('second answer'));
    await waitFor(() => fake.writes.join('').includes('third answer'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('▌ second prompt');
    expect(doc).toContain('▌ third prompt');
    expect(calls()).toBe(3);
    // The quit document is the whole layout: the editor row shows the idle
    // key hints, never the working line — the queue waiting in the inbox did
    // not keep the session busy.
    expect(doc).toContain('⏎ send');
    expect(doc).not.toContain('working…');
  });

  it('replays a cancel that lands in the compaction admission window (#330 review)', async () => {
    // #312/#334 solved the same race for turns: a Ctrl-C before the durable
    // submit lands is latched and replayed. A compaction's admission window
    // is the context read plus the admission commit; a cancel there must
    // abort the task that appears, not be lost.
    let releaseAdmission: () => void = () => {};
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let aborts = 0;
    const loop = {
      compact: async (
        _focus: string | undefined,
        _context: unknown,
        options?: {
          onAdmitted?: (taskId: string) => void | Promise<void>;
        },
      ) => {
        await admissionGate;
        await options?.onAdmitted?.('7');
        // Only a second abort (the replay) cancels the admitted task.
        return aborts > 1
          ? { status: 'aborted' as const, tokensBefore: 42 }
          : { status: 'completed' as const, tokensBefore: 42 };
      },
      abort: async () => {
        aborts += 1;
      },
      context: {},
    } as unknown as TuiLaneLoop;
    const turn = new TuiCompactionTurn(loop, 'focus');
    const running = turn.run('/compact focus');
    // The key lands while the task is still being admitted.
    await turn.cancel();
    expect(aborts).toBe(1);
    releaseAdmission();
    await expect(running).resolves.toEqual({ status: 'cancelled' });
    // cancel + the replay on admission.
    expect(aborts).toBe(2);
    expect(turn.settlementFooter()).toBe('compaction cancelled');
  });

  it('reports /compact with nothing to cut as nothing to compact (#330 review)', async () => {
    // The shipped keep-recent window is 20000 tokens, so a small session has
    // nothing to cut: Pi completes the task without placing a summary entry,
    // and the footer must not claim a compaction that never happened.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let lane: SoloLane | undefined;
    const { models } = fauxModels(['first answer']);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: fauxLaneBoot(root, models, {
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
    for (const ch of '/compact') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      /nothing to compact: \d+ tokens/.test(fake.writes.join('')),
    );
    if (lane === undefined) throw new Error('the lane never booted');
    const page = await lane.conversation.entries(
      {},
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(
      page.items.filter((entry) => CompactionEntry.is(entry)),
    ).toHaveLength(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('refuses /thinking and the cycle key while a turn runs (#328)', async () => {
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
    // The command form is refused with the reason, and the draft comes back.
    for (const ch of '/thinking high') fake.feed(ch);
    const refusedAt = fake.writes.length;
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('thinking: finish the current turn before switching'),
    );
    // The cycle key is refused the same way.
    const mark = fake.writes.length;
    fake.feed('\u001bt');
    await waitFor(() =>
      fake.writes
        .slice(mark)
        .join('')
        .includes('thinking: finish the current turn before switching'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    // Issue #302: with a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it (#454).
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.writes.slice(refusedAt).join('')).toContain('/thinking high');
  });

  it('answers /help, /session and /diff locally and refuses an unknown command (#305)', async () => {
    // Acceptance (#305): an unknown slash command is refused on the footer
    // and NEVER reaches the model; the registry's own commands answer from
    // the loop (no turn, no model call at all here).
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
    // A refused command keeps the draft (#334), so each one starts from an
    // empty editor (Ctrl-U: delete to line start).
    const run = (command: string): void => {
      fake.feed('\x15');
      for (const ch of command) fake.feed(ch);
      fake.feed('\r');
    };
    run('/foo');
    await waitFor(() =>
      fake.writes.join('').includes("unknown command '/foo'"),
    );
    expect(calls()).toBe(0);
    run('/help');
    await waitFor(() => fake.writes.join('').includes('help: 19 commands'));
    // The list itself landed in the transcript, generated from the registry.
    expect(fake.writes.join('')).toContain('/quit — leave the TUI');
    run('/help resume');
    await waitFor(() => fake.writes.join('').includes('help: /resume'));
    run('/session');
    await waitFor(() => fake.writes.join('').includes('in 0 out 0 (cached 0)'));
    expect(fake.writes.join('')).toContain('thinking off');
    run('/diff');
    await waitFor(() => fake.writes.join('').includes('diff: panel open'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // Not one of the commands spent a model call.
    expect(calls()).toBe(0);
  });

  it('refuses the side-effecting commands while a turn runs (#305 review)', async () => {
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
    expect(await pending).toBe(0);
    expect(calls()).toBe(1);
  });

  it('runs a command from the Ctrl-P palette (#305)', async () => {
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
    expect(await pending).toBe(0);
    expect(calls()).toBe(0);
  });

  it('a durably busy conversation refuses the second turn with the busy failure', async () => {
    // The runner-level half of the busy contract (D6.1), with the UI's own
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
        // Issue #333: the runner folds events through its projector and hands
        // the app the resulting state.
        applyPresentation: () => {},
        setUsage: () => {},
        presentationSeed: () => ({
          sessionId: 'sess-1',
          model: 'faux/faux-1',
          approvalsSkipped: false,
        }),
      } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
      const runner = new TuiTurnRunner(
        app,
        soloTuiLoop(lane.solo),
        'faux/faux-1',
      );
      const first = lane.run('first prompt');
      // The run is live: its model request has started.
      await waitFor(() => lane.faux.state.callCount === 1);
      const refused = await runner.run('second prompt');
      expect(refused.status).toBe('failed');
      expect(refused.detail).toContain('lane refused the prompt');
      expect(lane.faux.state.callCount).toBe(1);
      // The durable fact behind the footer text: the submit is rejected by
      // pi-durable, not queued (lane/turn.ts's D6.1 mapping of it is pinned
      // by lane/turn.test.ts).
      await expect(
        lane.solo.conversation.submit(
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
    // RED before the fix: the loop compared raw input against legacy
    // control bytes ('\x03', '\x04'), so a Kitty-class terminal — which
    // sends CSI-u sequences ('\x1b[99;5u' for Ctrl-C, '\x1b[100;5u' for
    // Ctrl-D) — hit the fall-through branch and did nothing: `consumed: true`
    // with no effect, the exact silent no-op key the criterion forbids. Esc
    // ('\x1b[27u') no longer quits at all (issue #454); Ctrl-C quits on its
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
      expect(await pending).toBe(0);
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
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    release();
  });

  it('quits on stdin EOF so a detached tty cannot hang the alt-screen', async () => {
    // Criterion 4: EOF is defined behaviour, not a silent no-op. Pi's
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
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    // The listener is removed with the screen: a second EOF is inert and
    // the process holds no dangling handler on the real stream.
    process.stdin.emit('end');
    expect(fake.counts.stopped).toBe(1);
  });

  it('Esc interrupts a busy turn and never quits (#302, #454)', async () => {
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
    // Idle, empty editor: Esc is still not a quit — it enters block mode
    // (issue #463), and a second Esc returns to typing.
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
    expect(await pending).toBe(0);
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
      expect(await pending).toBe(0);
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    // Issue #453: the header above the transcript, the status line below.
    const order = ['approvals on', '▌ a question', 'answered', ' ready '].map(
      (marker) => doc.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Issue #455: the committed prompt carries its time through the whole
    // production wire (laneEntryFor → entriesToCells → the prompt block).
    expect(doc).toMatch(/▌ a question +you · \d\d:\d\d:\d\d/);
  });
});

describe('kubic tui docs contract (issue #88)', () => {
  it('lists every key the shipped loop honours, including submit', () => {
    const docs = readFileSync(
      new URL('../../../docs/cli/commands.md', import.meta.url),
      'utf8',
    );
    const start = docs.indexOf('## `kubic tui');
    const end = docs.indexOf('## `kubic sessions');
    // Both anchors must exist, in order: otherwise the slice silently widens
    // to the whole page and the key checks pass off unrelated sections.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = docs.slice(start, end);
    for (const key of [
      'Enter',
      'Ctrl-J',
      'Shift+Enter',
      'Ctrl-T',
      'Ctrl-C',
      'Esc',
      'Ctrl-D',
    ]) {
      expect(section).toContain(key);
    }
    expect(section).toMatch(/submit/i);
  });
});

// Issue #453: the header's live facts — the workspace the composition root
// reads (at boot and after every settled turn) and the wall clock.
describe('the header facts on the live loop (issue #453)', () => {
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
    expect(await pending).toBe(0);
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
      expect(await pending).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Issue #457 (01-J): every settled solo turn ends with its receipt — the
// whole production wire: the turn's tool call, the journal row its write
// recorded, and the receipt the settlement appends.
describe('the turn receipt on the live loop (issue #457)', () => {
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
    expect(await pending).toBe(0);
  });
});
