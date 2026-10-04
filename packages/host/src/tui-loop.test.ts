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
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { bootSoloLane } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

type FauxContent = Parameters<typeof fauxAssistantMessage>[0];
type FauxMessage = ReturnType<typeof fauxAssistantMessage>;
type FauxStep = FauxContent | (() => Promise<FauxMessage>);

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
        return fauxAssistantMessage(
          step,
          toolUse ? { stopReason: 'toolUse' } : undefined,
        );
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
    });
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
    // glyph + duration line ('✓ bash 1ms') that only AgentTreeView produces
    // (the transcript writes 'tool bash', with no glyph and no duration), so
    // deleting `this.app.applyLaneEvent(event)` from TuiTurnRunner turns
    // this red. Verified by mutation: it does.
    expect(doc).toMatch(/✓ bash \d+ms/);
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

  it('refuses a second submit while the conversation is busy, locally', async () => {
    // Acceptance (#395): a busy TUI conversation is refused locally, as
    // today. The input loop owns the refusal — the second prompt never
    // reaches the durable submit — and the lane keeps its one in-flight turn.
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
    // The turn is in flight (the model is gated): a second Enter must not
    // start another turn.
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await waitFor(() => fake.writes.join('').includes('first answer'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('› first prompt');
    // One model request for the one turn: the busy submit never reached the
    // lane (the editor's own echo of a refused draft is not a lane cell).
    expect(calls()).toBe(1);
    expect(doc).not.toContain('second answer');
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
