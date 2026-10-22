// Context-overflow recovery: compact, then retry once.
// Faux provider only, MemoryStorage, zero network. The overflow itself is a
// fabricated failed outcome (faux turns never overflow); the compaction and
// the retry turn run for real on the faux lane.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  fauxAssistantMessage,
} from '../pi-boundary.js';
import {
  bootFauxLane,
  type FauxLane,
  type FauxResponseStep,
} from '../test-support/lane-harness.js';
import type { RetryDecision } from './failures.js';
import { RetryBudget } from './failures.js';
import { recoverOverflowTurn, runTurnWithOverflowRecovery } from './turn.js';

const LANES: FauxLane[] = [];

afterEach(async () => {
  for (const lane of LANES.splice(0)) {
    await lane.cleanup();
  }
});

async function open(
  responses = [fauxAssistantMessage('ok')],
): Promise<FauxLane> {
  const lane = await bootFauxLane({ responses });
  LANES.push(lane);
  return lane;
}

/** A lane on a faux model with the given window; the reserve follows the window. */
async function openWindow(
  contextWindow: number,
  responses: FauxResponseStep[],
): Promise<FauxLane> {
  const lane = await bootFauxLane({
    models: [{ id: 'window', contextWindow, maxTokens: 2048 }],
    model: 'window',
    responses,
  });
  LANES.push(lane);
  return lane;
}

const SUMMARY = '## Goal\nkeep the work going.';

/** Text of about `tokens` estimated tokens (chars / 4), starting with `label`. */
function text(label: string, tokens: number): string {
  return `${label} ${'x'.repeat(Math.max(1, tokens * 4 - label.length - 1))}`;
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

async function compactionCount(lane: FauxLane): Promise<number> {
  return (await lane.entries()).filter((entry) => CompactionEntry.is(entry))
    .length;
}

describe('overflow recovery', () => {
  it('a completed turn passes through with no retry and no decision', async () => {
    const lane = await open();
    const result = await runTurnWithOverflowRecovery(lane.lane, 'hi', {
      requestId: 'req-1',
      context: BACKGROUND_CONTEXT,
    });
    expect(result.outcome.kind).toBe('completed');
    expect(result.retried).toBe(false);
    expect(result.decision).toBeUndefined();
    expect(result.compaction).toBeUndefined();
  });

  it('a non-overflow failure passes through with no retry', async () => {
    const lane = await open();
    const failed = { reason: 'tool_failed' as const, error: 'boom' };
    const recovered = await recoverOverflowTurn(lane.lane, 'hi', failed, {
      requestId: 'req-1',
      context: BACKGROUND_CONTEXT,
    });
    expect(recovered.outcome).toEqual({ kind: 'failed', ...failed });
    expect(recovered.retried).toBe(false);
    expect(recovered.decision).toBeUndefined();
    expect(recovered.compaction).toBeUndefined();
  });

  it('context overflow compacts, then retries once to completion', async () => {
    const lane = await open([
      fauxAssistantMessage('summary text'),
      fauxAssistantMessage('retry-ok'),
    ]);
    const seen: RetryDecision[] = [];
    const recovered = await recoverOverflowTurn(
      lane.lane,
      'do the thing',
      { reason: 'context_overflow', error: 'too many tokens' },
      { requestId: 'req-1', context: BACKGROUND_CONTEXT },
      { onRetryDecision: (decision) => seen.push(decision) },
    );
    expect(recovered.retried).toBe(true);
    expect(recovered.decision?.decision).toBe('retry_with_new_context');
    expect(recovered.decision?.reason).toContain('retry 1/1');
    expect(seen).toHaveLength(1);
    expect(recovered.outcome.kind).toBe('completed');
  });

  it('overflow recovery on a 200k model keeps the 20000-token window, not the manual one', async () => {
    // Three turns of 5000-token messages: about 30000 estimated tokens of
    // history, so the 20000-token kept window has a cut to make.
    const lane = await openWindow(200000, [
      fauxAssistantMessage(text('reply one', 5000)),
      fauxAssistantMessage(text('reply two', 5000)),
      fauxAssistantMessage(text('reply three', 5000)),
      fauxAssistantMessage(SUMMARY),
      fauxAssistantMessage('retry-ok'),
    ]);
    for (let turn = 1; turn <= 3; turn++) {
      expect((await lane.run(text(`user ${turn}`, 5000))).status).toBe(
        'completed',
      );
    }
    const recovered = await recoverOverflowTurn(
      lane.lane,
      'do the thing',
      { reason: 'context_overflow', error: 'prompt is too long' },
      { requestId: 'req-1', context: BACKGROUND_CONTEXT },
    );
    expect(recovered.retried).toBe(true);
    expect(recovered.compaction?.status).toBe('completed');
    expect(recovered.outcome.kind).toBe('completed');
    expect(await compactionCount(lane)).toBe(1);
    expect(await keptTokens(lane)).toBeGreaterThanOrEqual(18000);
  });

  it('overflow recovery on a 16k model keeps at least the 3072-token kept window', async () => {
    // Blocking threshold 12288. Turns of 1000 + 1000 keep the context under
    // it while the history is built: at 2000-token turns the threshold fires
    // during the build and spends the scripted summaries.
    const lane = await openWindow(16384, [
      fauxAssistantMessage(text('reply one', 1000)),
      fauxAssistantMessage(text('reply two', 1000)),
      fauxAssistantMessage(text('reply three', 1000)),
      fauxAssistantMessage(SUMMARY),
      fauxAssistantMessage('retry-ok'),
    ]);
    for (let turn = 1; turn <= 3; turn++) {
      expect((await lane.run(text(`user ${turn}`, 1000))).status).toBe(
        'completed',
      );
    }
    const recovered = await recoverOverflowTurn(
      lane.lane,
      'do the thing',
      { reason: 'context_overflow', error: 'prompt is too long' },
      { requestId: 'req-1', context: BACKGROUND_CONTEXT },
    );
    expect(recovered.retried).toBe(true);
    expect(recovered.compaction?.status).toBe('completed');
    expect(recovered.outcome.kind).toBe('completed');
    expect(await compactionCount(lane)).toBe(1);
    expect(await keptTokens(lane)).toBeGreaterThanOrEqual(3072);
  });

  it('an exhausted budget abandons without compacting or retrying', async () => {
    const lane = await open();
    const failed = { reason: 'context_overflow' as const, error: 'full' };
    const recovered = await recoverOverflowTurn(
      lane.lane,
      'do the thing',
      failed,
      { requestId: 'req-1', context: BACKGROUND_CONTEXT },
      { retryBudget: new RetryBudget(0) },
    );
    expect(recovered.retried).toBe(false);
    expect(recovered.decision?.decision).toBe('abandon');
    expect(recovered.decision?.reason).toContain('retry budget');
    expect(recovered.compaction).toBeUndefined();
    expect(recovered.outcome).toEqual({ kind: 'failed', ...failed });
  });
});
