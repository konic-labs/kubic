// One read of the session summaries serves the palette and
// `/resume` for a short while — a summary parses a whole session file.
import { describe, expect, it } from 'vitest';
import { cachedSummaries, SESSION_SUMMARY_TTL_MS } from './tui-run.js';

describe('cached session summaries', () => {
  it('shares one read within the window, per asking session', async () => {
    let now = 1000;
    let reads = 0;
    const summaries = cachedSummaries(
      async (exclude) => {
        reads += 1;
        return [{ id: `not-${exclude ?? 'none'}`, state: 'ready' as const }];
      },
      () => now,
    );
    await summaries('a');
    await summaries('a');
    expect(reads).toBe(1);
    await summaries('b');
    expect(reads).toBe(2);
    now += SESSION_SUMMARY_TTL_MS;
    expect(await summaries('b')).toEqual([{ id: 'not-b', state: 'ready' }]);
    expect(reads).toBe(3);
  });

  it('never keeps a failed read', async () => {
    let reads = 0;
    const summaries = cachedSummaries(async () => {
      reads += 1;
      if (reads === 1) throw new Error('torn');
      return [];
    });
    await expect(summaries()).rejects.toThrow('torn');
    expect(await summaries()).toEqual([]);
    expect(reads).toBe(2);
  });
});
