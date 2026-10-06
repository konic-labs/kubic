// Solo context-overflow recovery (issue #209): compact, then retry once.
// Faux provider only, MemoryStorage, zero network. The overflow itself is a
// fabricated failed outcome (faux turns never overflow); the compaction and
// the retry turn run for real on the faux lane.
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT, fauxAssistantMessage } from '../pi-boundary.js';
import type { RetryDecision } from './failures.js';
import { RetryBudget } from './failures.js';
import { bootFauxLane, type FauxLane } from './test-harness.js';
import {
  recoverSoloOverflowTurn,
  runTurnWithOverflowRecovery,
} from './turn.js';

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

describe('solo overflow recovery (issue #209)', () => {
  it('a completed turn passes through with no retry and no decision', async () => {
    const lane = await open();
    const result = await runTurnWithOverflowRecovery(lane.solo, 'hi', {
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
    const recovered = await recoverSoloOverflowTurn(lane.solo, 'hi', failed, {
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
    const recovered = await recoverSoloOverflowTurn(
      lane.solo,
      'do the thing',
      { reason: 'context_overflow', error: 'too many tokens' },
      { requestId: 'req-1', context: BACKGROUND_CONTEXT },
      { onRetryDecision: (decision) => seen.push(decision) },
    );
    expect(recovered.retried).toBe(true);
    expect(recovered.decision?.decision).toBe('retry_with_new_context');
    expect(recovered.decision?.reason).toContain('retry 1/1');
    expect(seen).toHaveLength(1);
    expect(recovered.compaction).toBeDefined();
    expect(recovered.outcome.kind).toBe('completed');
  });

  it('an exhausted budget abandons without compacting or retrying', async () => {
    const lane = await open();
    const failed = { reason: 'context_overflow' as const, error: 'full' };
    const recovered = await recoverSoloOverflowTurn(
      lane.solo,
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
