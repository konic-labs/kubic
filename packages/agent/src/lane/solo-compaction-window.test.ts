// Compaction through the REAL solo lane (`bootFauxLane`, faux models, zero
// network): automatic, overflow and manual compaction on small and mid-size
// windows, and a model switch that moves the kept window and the reserve
// live. The faux provider estimates usage from the request text (chars / 4),
// so a reply of N estimated tokens grows the context by about N per turn; the
// system prompt and the tool definitions are not in that estimate.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveKeepRecentTokens,
  effectiveReserveTokens,
  runCompactCommand,
  runManualCompaction,
  KEEP_RECENT_TOKENS,
  SYSTEM_ENTRY_ESTIMATE,
} from '../compaction.js';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  estimateContextTokens,
  fauxAssistantMessage,
  SystemEntry,
} from '../pi-boundary.js';
import {
  bootFauxLane,
  type FauxLane,
  type FauxResponseStep,
} from './test-harness.js';

const LANES: FauxLane[] = [];

afterEach(async () => {
  for (const lane of LANES.splice(0)) await lane.cleanup();
});

const SUMMARY = '## Goal\nkeep the work going.';

/** Text of about `tokens` estimated tokens (chars / 4), starting with `label`. */
function text(label: string, tokens: number): string {
  return `${label} ${'x'.repeat(Math.max(1, tokens * 4 - label.length - 1))}`;
}

/** The summarizer's request: pi-durable's summarization system prompt first. */
function isSummaryRequest(
  messages: readonly { readonly role?: unknown; readonly content?: unknown }[],
): boolean {
  const first = messages[0];
  return (
    first?.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.includes('context summarization assistant')
  );
}

/**
 * Scripted faux responses. Summary requests get the summary (and report the
 * token budget pi gave them); agent requests get `reply(index)`, except the
 * request at `overflowAt`, which fails once with a context-overflow error.
 */
function scripted(
  reply: (index: number) => string,
  options: {
    overflowAt?: number;
    onSummary?: (maxTokens: number | undefined) => void;
  } = {},
): FauxResponseStep[] {
  const steps: FauxResponseStep[] = [];
  let agent = 0;
  let overflowed = false;
  for (let step = 0; step < 200; step++) {
    steps.push((transcript, requestOptions) => {
      if (isSummaryRequest(transcript.messages)) {
        options.onSummary?.(requestOptions?.maxTokens);
        return fauxAssistantMessage(SUMMARY);
      }
      const index = agent++;
      if (options.overflowAt === index && !overflowed) {
        overflowed = true;
        return fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'prompt is too long: 17000 tokens > 16384 maximum',
        });
      }
      return fauxAssistantMessage(reply(index));
    });
  }
  return steps;
}

function model(id: string, contextWindow: number, maxTokens?: number) {
  return {
    id,
    contextWindow,
    maxTokens: maxTokens ?? Math.min(2048, contextWindow / 4),
  };
}

async function bootWindow(
  contextWindow: number,
  options: { reply?: (index: number) => string; overflowAt?: number } = {},
): Promise<FauxLane> {
  const lane = await bootFauxLane({
    models: [model('window', contextWindow)],
    model: 'window',
    responses: scripted(options.reply ?? (() => 'ok'), options),
  });
  LANES.push(lane);
  return lane;
}

async function compactionEntries(lane: FauxLane) {
  return (await lane.entries()).filter((entry) => CompactionEntry.is(entry));
}

function reasonOf(entry: { readonly data?: unknown }): unknown {
  return (entry.data as { reason?: unknown } | undefined)?.reason;
}

/** The active context's estimated tokens, counted the way the harness counts them. */
async function contextTokens(lane: FauxLane): Promise<number> {
  const view = await lane.lane.conversation.context(BACKGROUND_CONTEXT);
  return estimateContextTokens(view.messages).tokens;
}

/** Estimated tokens of a message's text blocks, counted as the estimator does. */
function textTokens(message: { readonly content?: unknown }): number {
  const content = message.content;
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  const chars = content.reduce((sum: number, part: unknown) => {
    const body = (part as { text?: unknown } | null)?.text;
    return sum + (typeof body === 'string' ? body.length : 0);
  }, 0);
  return Math.ceil(chars / 4);
}

/** The verbatim history after the summary head: the kept window. */
async function keptTokens(lane: FauxLane): Promise<number> {
  const view = await lane.lane.conversation.context(BACKGROUND_CONTEXT);
  return view.contributions
    .slice(view.head === undefined ? 0 : 1)
    .flat()
    .filter((message) => message.role !== 'system')
    .reduce((sum, message) => sum + textTokens(message), 0);
}

/** The committed system entry's estimated tokens: its prompt and tool set. */
async function systemEntryTokens(lane: FauxLane): Promise<number> {
  const entries = await lane.entries();
  const system = entries.find((entry) => SystemEntry.is(entry));
  const messages = (system?.model ?? []) as never[];
  return estimateContextTokens(messages).tokens;
}

// ─── automatic compaction on small and mid-size windows ───────────────────

/**
 * Runs turns until the first compaction is placed. The provider overflows once
 * the context passes `window`, so a compaction that comes later than that
 * point does not save the session: the loop stops there and returns no entry.
 */
async function turnsUntilCompaction(
  lane: FauxLane,
  window: number,
  userTokens: number,
) {
  for (let turn = 0; turn < 20; turn++) {
    if ((await contextTokens(lane)) > window) break;
    expect((await lane.run(text(`user ${turn}`, userTokens))).status).toBe(
      'completed',
    );
    if ((await compactionEntries(lane)).length > 0) break;
  }
  return compactionEntries(lane);
}

describe('threshold compaction runs on every supported window', () => {
  it('places a threshold compaction on a 16k window before the context overflows it', async () => {
    // Blocking threshold: 16384 - 4096 = 12288 estimated tokens. Each turn
    // adds about 2100, so the threshold is crossed around the seventh turn.
    const lane = await bootWindow(16384, { reply: () => text('reply', 2000) });
    const entries = await turnsUntilCompaction(lane, 16384, 100);
    expect(entries).toHaveLength(1);
    expect(reasonOf(entries[0] ?? {})).toBe('threshold');
  });

  it('places a threshold compaction on a 32k window before the context overflows it', async () => {
    // Blocking threshold: 32768 - 8192 = 24576 estimated tokens. The history
    // at the threshold holds more than the 20000-token kept window, so a cut
    // exists without any help: the test guards that this band keeps working.
    const lane = await bootWindow(32768, { reply: () => text('reply', 4000) });
    const entries = await turnsUntilCompaction(lane, 32768, 100);
    expect(entries).toHaveLength(1);
    expect(reasonOf(entries[0] ?? {})).toBe('threshold');
  });

  it('places a threshold compaction on an 8k window before the context overflows it', async () => {
    // Blocking threshold: 8192 - 2048 = 6144 estimated tokens. The system
    // prompt and tool definitions alone take about a third of this window.
    const lane = await bootWindow(8192, { reply: () => text('reply', 1500) });
    const entries = await turnsUntilCompaction(lane, 8192, 100);
    expect(entries).toHaveLength(1);
    expect(reasonOf(entries[0] ?? {})).toBe('threshold');
  });
});

// ─── overflow recovery ────────────────────────────────────────────────────

describe('overflow recovery compacts and retries', () => {
  it('recovers from a context overflow on a 16k window: compacts, then retries once', async () => {
    // Three turns of about 2000 estimated tokens stay below the 12288-token
    // threshold, so the fourth request is the first to overflow.
    const lane = await bootWindow(16384, {
      reply: () => text('reply', 2000),
      overflowAt: 3,
    });
    for (let turn = 0; turn < 3; turn++) {
      expect((await lane.run(text(`user ${turn}`, 100))).status).toBe(
        'completed',
      );
    }
    expect((await lane.run(text('user 3', 100))).status).toBe('completed');
    const entries = await compactionEntries(lane);
    expect(entries.map(reasonOf)).toEqual(['overflow']);
  });
});

// ─── manual compaction ────────────────────────────────────────────────────

describe('manual compaction (/compact)', () => {
  it('places a summary on a short session (about 5k tokens on a 200k window)', async () => {
    const lane = await bootWindow(200000, { reply: () => text('reply', 800) });
    for (let turn = 0; turn < 4; turn++) {
      expect((await lane.run(text(`user ${turn}`, 200))).status).toBe(
        'completed',
      );
    }
    const outcome = await runCompactCommand(
      lane.lane,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('completed');
    expect((await compactionEntries(lane)).map(reasonOf)).toEqual(['manual']);
  });

  it('reports a session that is only its most recent turn as nothing to compact, with the reason', async () => {
    const lane = await bootWindow(200000, { reply: () => text('reply', 300) });
    expect((await lane.run(text('user only', 200))).status).toBe('completed');
    const outcome = await runCompactCommand(
      lane.lane,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.status).toBe('nothing');
    expect(outcome.reason).toBe('most-recent-turn');
    expect(await compactionEntries(lane)).toHaveLength(0);
  });
});

// ─── the kept window against the real system prompt ───────────────────────

describe('the kept window beside the real system prompt and tool set', () => {
  it('keeps the kept window below the room the threshold leaves beside the system entry', async () => {
    // The default boot offers the full Kubic tool set. The system entry is
    // part of the transcript, so its tokens sit inside the threshold budget.
    const lane = await bootFauxLane({});
    LANES.push(lane);
    expect((await lane.run('hello')).status).toBe('completed');
    const systemTokens = await systemEntryTokens(lane);
    expect(systemTokens).toBeGreaterThan(0);
    for (const window of [8192, 16384, 32768, 131072, 200000]) {
      const blocking =
        window - effectiveReserveTokens(window, DEFAULT_RESERVE_TOKENS);
      const keep = effectiveKeepRecentTokens(
        window,
        KEEP_RECENT_TOKENS,
        DEFAULT_RESERVE_TOKENS,
      );
      expect(keep, `window ${window}`).toBeLessThan(blocking - systemTokens);
    }
  });

  it('pins the system entry estimate to the default boot, within 5 percent', async () => {
    const lane = await bootFauxLane({});
    LANES.push(lane);
    expect((await lane.run('hello')).status).toBe('completed');
    const tokens = await systemEntryTokens(lane);
    expect(
      Math.abs(tokens - SYSTEM_ENTRY_ESTIMATE) / SYSTEM_ENTRY_ESTIMATE,
    ).toBeLessThan(0.05);
  });

  it.each([8192, 16384, 32768, 131072, 200000])(
    'finds a cut at the blocking threshold on a %i window',
    async (window) => {
      // Build the history up to the threshold: the non-system messages fill
      // the room below it, beside the real system entry. Then pi's own cut
      // selection, with the window's kept window, must find a cut.
      // The history is built on a 400k model, where no threshold can fire: the
      // faux usage counts the system entry about twice, so building it on the
      // window under test would compact during the build. The window under
      // test is switched on afterwards, and its kept window must find the cut.
      const lane = await bootFauxLane({
        models: [model('build', 400000, 20000), model('target', window)],
        model: 'build',
        responses: scripted(() => text('reply', 20)),
      });
      LANES.push(lane);
      expect((await lane.run('hello')).status).toBe('completed');
      const systemTokens = await systemEntryTokens(lane);
      const blocking =
        window - effectiveReserveTokens(window, DEFAULT_RESERVE_TOKENS);
      const history = blocking - systemTokens - 1500;
      expect((await lane.run(text('long question', history))).status).toBe(
        'completed',
      );
      expect((await lane.run('short follow-up')).status).toBe('completed');
      await lane.lane.conversation.configure(
        { model: { provider: 'faux', modelId: 'target' } },
        BACKGROUND_CONTEXT,
      );
      const outcome = await runManualCompaction(
        lane.lane,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(outcome.status).toBe('completed');
      expect(await compactionEntries(lane)).toHaveLength(1);
    },
  );
});

// ─── a model switch moves both budgets, live ──────────────────────────────

describe('a model switch moves the budgets live, as the harness applies them', () => {
  it('moves the kept window and the summary reserve with configure({ model })', async () => {
    const budgets: Array<number | undefined> = [];
    const lane = await bootFauxLane({
      models: [model('small', 8192, 2048), model('large', 200000, 20000)],
      model: 'large',
      responses: scripted(() => text('reply', 4000), {
        onSummary: (maxTokens) => budgets.push(maxTokens),
      }),
    });
    LANES.push(lane);
    // Three turns of 4000 + 4000 estimated tokens on the large model.
    for (let turn = 0; turn < 3; turn++) {
      expect((await lane.run(text(`user ${turn}`, 4000))).status).toBe(
        'completed',
      );
    }

    // The 8k window: the summary budget is 0.8 of its 2048 reserve, and the
    // kept window is 1536 tokens, so the cut keeps only the last message.
    await lane.lane.conversation.configure(
      { model: { provider: 'faux', modelId: 'small' } },
      BACKGROUND_CONTEXT,
    );
    expect(
      (await runManualCompaction(lane.lane, undefined, BACKGROUND_CONTEXT))
        .status,
    ).toBe('completed');
    expect(budgets.at(-1)).toBe(1638);
    expect(await keptTokens(lane)).toBeLessThan(8000);

    // The 200k window again: the summary budget is 0.8 of 16384, and the kept
    // window is the configured 20000 tokens.
    await lane.lane.conversation.configure(
      { model: { provider: 'faux', modelId: 'large' } },
      BACKGROUND_CONTEXT,
    );
    for (let turn = 3; turn < 6; turn++) {
      expect((await lane.run(text(`user ${turn}`, 4000))).status).toBe(
        'completed',
      );
    }
    expect(
      (await runManualCompaction(lane.lane, undefined, BACKGROUND_CONTEXT))
        .status,
    ).toBe('completed');
    expect(budgets.at(-1)).toBe(13107);
    expect(await keptTokens(lane)).toBeGreaterThanOrEqual(18000);
  });
});
