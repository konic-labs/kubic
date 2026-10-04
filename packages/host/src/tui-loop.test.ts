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
import { afterEach, describe, expect, it } from 'vitest';
import {
  runTuiCommand,
  soloTuiLoop,
  TuiCompactionTurn,
  type TuiLaneLoop,
  type TuiRunDeps,
  TuiTurnRunner,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { bootSoloLane, type SoloLane } from '../../worker/src/lane/solo.js';
import {
  bootFauxLane,
  fauxToolUse,
} from '../../worker/src/lane/test-harness.js';
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
} from '../../worker/src/pi-boundary.js';

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
    const solo = await bootSoloLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    });
    options.onBoot?.(solo);
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
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
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
        onStart?.(input);
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return width;
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
    feed: (data: string): void => {
      handler?.(data);
    },
  };
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

async function waitFor(condition: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('› say done');
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
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    // The tree reflects the tool call: applyLaneEvent has a production
    // caller on the loop path. Asserted on the TREE's own rendering — the
    // glyph + name + args + duration line ('✓ bash echo hi 1ms') that only
    // AgentTreeView produces (the transcript writes 'tool bash', with no
    // glyph and no duration), so deleting `this.app.applyLaneEvent(event)`
    // from TuiTurnRunner turns this red. Verified by mutation: it does.
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
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
      release();
      fake.feed('\x03'); // idle again: Ctrl-C quits
      expect(await pending).toBe(0);
      // The released turn keeps settling in the background after the loop
      // quits; wait for its result to reach the session log so afterEach's
      // rmSync is not raced by a late append that recreates the temp root.
      await waitFor(() => sessionLogIncludes(root, '"kind":"pi.assistant"'));
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    // Both prompts are in the transcript, and the model ran twice: the
    // queued follow-up really was delivered after settlement.
    expect(doc).toContain('› first prompt');
    expect(doc).toContain('› second prompt');
    expect(calls()).toBe(2);
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
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('keeps the draft when a submit is refused (#334 review)', async () => {
    // A refused prompt must never eat the text: the editor is live during a
    // turn (#334), so `/model` while busy (and any orchestrator-busy submit)
    // hands the draft back instead of clearing it.
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
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('model: finish the current turn before switching'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // The whole layout at quit carries the draft in the editor row: a
    // refused submit put it back (a frame scan could match the characters as
    // they were TYPED, before the Enter cleared them).
    expect(lines.join('\n')).toContain('/model faux/other');
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
    fake.feed('\x1b\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('model: finish the current turn before switching'),
    );
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('/model faux/other');
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
    // The latch really released: Ctrl-G is refused only while the app is
    // busy, so the toggle must flip the session mode (and back).
    const mark = fake.writes.length;
    // Ctrl-G (0x07): the app refuses the toggle only while it is busy.
    fake.feed('\x07');
    await waitFor(() =>
      fake.writes.slice(mark).join('').includes('orchestrator ·'),
    );
    expect(fake.writes.slice(mark).join('')).not.toContain(
      'mode: finish the current turn',
    );
    fake.feed('\x07');
    await waitFor(() =>
      fake.writes.slice(mark).join('').includes('solo · faux'),
    );
    // The next submit places the queue: the waiting follow-up runs first,
    // and the new prompt follows it (oldest first, one per boundary).
    for (const ch of 'third prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('second answer'));
    await waitFor(() => fake.writes.join('').includes('third answer'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('› second prompt');
    expect(doc).toContain('› third prompt');
    expect(calls()).toBe(3);
    // The quit document is the whole layout: the editor row shows the idle
    // key hints, never the working line — the queue waiting in the inbox did
    // not keep the session busy.
    expect(doc).toContain('enter send');
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
    expect(await pending).toBe(0);
  });

  it('refuses /compact on the orchestrator lane and keeps the draft (#330 review)', async () => {
    // The session's own transcript belongs to the solo lane; while the
    // operator watches the orchestrator report, compacting that conversation
    // silently would act on the wrong lane.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels(['first answer']);
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
    // Ctrl-G (0x07) switches the session mode to orchestrator.
    fake.feed('\x07');
    await waitFor(() => fake.writes.join('').includes('orchestrator ·'));
    for (const ch of '/compact') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('the orchestrator lane has no session transcript to compact'),
    );
    fake.feed('\x03');
    expect(await pending).toBe(0);
    // Refused, so the draft came back (finding 1 of the #334 review).
    expect(lines.join('\n')).toContain('/compact');
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
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('/thinking high');
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
    await waitFor(() => fake.writes.join('').includes('help: 11 commands'));
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
    await waitFor(() => fake.writes.join('').includes('help: 11 commands'));
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
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
    await waitFor(() => fake.writes.join('').includes('help: 11 commands'));
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
        applyLaneEvent: () => {},
        setUsage: () => {},
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

  it('quits on the Kitty-protocol form of Esc and Ctrl-D, not only legacy bytes', async () => {
    // RED before the fix: the loop compared raw input against legacy
    // control bytes ('\x1b', '\x04'), so a Kitty-class terminal — which
    // sends CSI-u sequences ('\x1b[27u' for Esc, '\x1b[100;5u' for Ctrl-D)
    // — hit the fall-through branch and did nothing: `consumed: true` with
    // no effect, the exact silent no-op key the criterion forbids. Verified
    // from the pinned pi-tui: parseKey('\x1b[27u') === 'escape'.
    for (const key of ['\x1b[27u', '\x1b[100;5u']) {
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
      fake.feed(key);
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

  it('quits on Esc and on Ctrl-D with an empty draft', async () => {
    for (const key of ['\x1b', '\x04']) {
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
      fake.feed(key);
      expect(await pending).toBe(0);
      expect(fake.counts.stopped).toBe(1);
      expect(lines.join('\n')).toContain('approvals:on');
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    const order = ['› a question', 'answered', 'approvals:on'].map((marker) =>
      doc.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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
