// The `kubic tui` prompt loop over the lane: a prompt is accepted and driven,
// lane events reach the views, and the header facts and the turn receipt
// follow the live session. This file never imports @kubic/tui (dep-lint):
// the fake terminal satisfies the seam structurally, and the assertions read
// the restored main-screen document the loop prints. A real faux lane end to
// end: no network, no paid tokens.
import type { Lane } from '@kubic/agent/lane/boot';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  fauxAssistantMessage,
} from '@kubic/agent/pi-boundary';
import { describe, expect, it } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { TuiCompactionTurn } from '../../src/tui/compaction-turn.js';
import { runTuiCommand } from '../../src/tui/run.js';
import type { TuiLaneLoop } from '../../src/tui/types.js';
import { fauxLaneBoot, fauxModels } from '../fixtures/faux-lane.js';

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
  // A lane loop whose /compact settles as `outcome`: the footer reads only that.
  const compactSettling = (outcome: {
    readonly status: string;
    readonly tokensBefore: number;
    readonly reason?: string;
  }): TuiLaneLoop =>
    ({
      context: BACKGROUND_CONTEXT,
      compact: async () => outcome,
      abort: async () => undefined,
    }) as unknown as TuiLaneLoop;

  it('refuses /compact while a turn runs, with the reason on the footer', async () => {
    const root = tempDir('tui-loop-');
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lane: Lane | undefined;
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
    // With a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it.
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  it('cancels a running compaction with Ctrl-C and says so', async () => {
    const root = tempDir('tui-loop-');
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
      'second answer',
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
    // Two turns, so there is older history to compact (see the test above).
    for (const ch of 'second prompt') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('second answer'));
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
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  it('keeps the draft when a submit is refused', async () => {
    // A refused prompt must never eat the text: the editor is live during a
    // turn, so `/model` while busy hands the draft back instead of
    // clearing it.
    const root = tempDir('tui-loop-');
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
    // With a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it.
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    // The frames drawn after the Enter carry the draft (the
    // typing that preceded the clear is outside the slice, so this proves
    // the restore rather than the input).
    expect(fake.writes.slice(refusedAt).join('')).toContain(
      '/model faux/other',
    );
  });

  it('keeps the draft when a steer is refused', async () => {
    // The Alt+Enter path clears the editor before the loop decides; a refusal
    // (a model command sent as a steer) must put it back too.
    const root = tempDir('tui-loop-');
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
    // With a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it.
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.writes.slice(refusedAt).join('')).toContain(
      '/model faux/other',
    );
  });

  it('releases the busy latch when a failed run leaves a queued follow-up', async () => {
    // pi-durable keeps queued inputs when a run faults. The waiting follow-up
    // is not work in flight: the spinner must stop, the queued row stays, and
    // the next submit places the queue (oldest first) and runs it.
    const root = tempDir('tui-loop-');
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
    expect((await pending).exitCode).toBe(0);
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

  it('replays a cancel that lands in the compaction admission window', async () => {
    // Solved the same race for turns: a Ctrl-C before the durable
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

  it('names the reason when /compact cut nothing for want of a cut point', async () => {
    const turn = new TuiCompactionTurn(
      compactSettling({
        status: 'nothing',
        tokensBefore: 1234,
        reason: 'no-cut',
      }),
      undefined,
    );
    await turn.run('/compact');
    expect(turn.settlementFooter()).toBe(
      'nothing to compact: no cut point before the most recent turn (1234 tokens)',
    );
  });

  it('names the most recent turn when there is no older history to compact', async () => {
    const turn = new TuiCompactionTurn(
      compactSettling({
        status: 'nothing',
        tokensBefore: 56,
        reason: 'most-recent-turn',
      }),
      undefined,
    );
    await turn.run('/compact');
    expect(turn.settlementFooter()).toBe(
      'nothing to compact: no history older than the most recent turn (56 tokens of context)',
    );
  });

  it('reports /compact with nothing to cut as nothing to compact', async () => {
    // The shipped keep-recent window is 20000 tokens, so a small session has
    // nothing to cut: Pi completes the task without placing a summary entry,
    // and the footer must not claim a compaction that never happened.
    const root = tempDir('tui-loop-');
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    let lane: Lane | undefined;
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
      /nothing to compact: no history older than the most recent turn \(\d+ tokens of context\)/.test(
        fake.writes.join(''),
      ),
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
    expect((await pending).exitCode).toBe(0);
  });

  it('refuses /thinking and the cycle key while a turn runs', async () => {
    const root = tempDir('tui-loop-');
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
    // With a draft in the editor the first Ctrl-C only clears it
    // (the footer says so — that message exists only for a non-empty draft),
    // so quitting needs a double press after it.
    fake.feed('\x03');
    await waitFor(() => fake.writes.join('').includes('^C: draft cleared'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.writes.slice(refusedAt).join('')).toContain('/thinking high');
  });

  it('answers /help, /session and /diff locally and refuses an unknown command', async () => {
    // Acceptance: an unknown slash command is refused on the footer
    // and NEVER reaches the model; the registry's own commands answer from
    // the loop (no turn, no model call at all here).
    const root = tempDir('tui-loop-');
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
    // A refused command keeps the draft, so each one starts from an
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
    expect((await pending).exitCode).toBe(0);
    // Not one of the commands spent a model call.
    expect(calls()).toBe(0);
  });
});
