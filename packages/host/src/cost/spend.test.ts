import type { EntryRecord } from '@kubic/agent/pi-boundary';
import { fauxAssistantMessage } from '@kubic/agent/pi-boundary';
import { bootFauxLane } from '@kubic/agent/test-support/lane-harness';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { assistantEntry } from '../test-support/run-entries.js';
import { SpendWatch, spendSince, spentToday, startOfUtcDay } from './spend.js';

function costing(id: number, timestamp: number, total: number): EntryRecord {
  return assistantEntry(id, timestamp, [{ type: 'text', text: 'ok' }], {
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    },
  }) as unknown as EntryRecord;
}

describe('spend caps', () => {
  const now = Date.parse('2026-10-21T15:30:00.000Z');

  it('sums the responses of the UTC day, nothing earlier', () => {
    const midnight = startOfUtcDay(now);
    expect(midnight).toBe(Date.parse('2026-10-21T00:00:00.000Z'));
    expect(
      spendSince(
        [
          costing(1, midnight - 1, 5),
          costing(2, midnight, 0.25),
          costing(3, now, 0.5),
        ],
        midnight,
      ),
    ).toBe(0.75);
  });

  it('stops a run at its own cap, naming the spend and the layer', () => {
    const watch = new SpendWatch({ run: { usd: 1, layer: 'enterprise' } }, 0);
    expect(watch.blocked()).toBeUndefined();
    expect(watch.add(0.6)).toBeUndefined();
    expect(watch.add(0.6)).toBe(
      'spend limit reached: this run cost $1.20, and [policy] max_run_cost_usd allows $1.00 (set by the enterprise layer)',
    );
  });

  it('refuses a day already spent, and stops a run that spends the rest', () => {
    const spent = new SpendWatch({ daily: { usd: 10, layer: 'global' } }, 10);
    expect(spent.blocked()).toBe(
      'daily spend limit reached: this machine spent $10.00 today (UTC), and [policy] max_daily_cost_usd allows $10.00 (set by the global layer)',
    );
    const room = new SpendWatch({ daily: { usd: 10, layer: 'global' } }, 9.5);
    expect(room.blocked()).toBeUndefined();
    expect(room.add(0.25)).toBeUndefined();
    expect(room.add(0.25)).toContain('daily spend limit reached');
  });

  it('reads the day of the session store, skipping a live session', async () => {
    const root = tempDir('spend-sessions-');
    const lane = await bootFauxLane({
      storage: 'jsonl',
      root,
      responses: [fauxAssistantMessage('answer')],
    });
    await lane.run('prompt');
    // Live: held by the lane, never opened.
    expect(await spentToday(root, Date.now())).toBe(0);
    await lane.cleanup();
    // Faux responses cost nothing; the read itself succeeds.
    expect(await spentToday(root, Date.now())).toBe(0);
    expect(await spentToday(tempDir('spend-empty-'))).toBe(0);
  });
});
