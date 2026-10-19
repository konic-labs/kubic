// The retention plan as a table: which entries a pass keeps, from the index
// and the blob sizes alone. The executor and its I/O are covered by
// retention.test.ts.
import { describe, expect, it } from 'vitest';
import { serializeEntry } from './index-file.js';
import { blobHashesOf, oldestTimestampOf, planRetention } from './retention.js';
import type { JournalEntry } from './types.js';

function entry(
  n: number,
  hashes: { before?: string; after?: string; delta?: string } = {},
  timestamp = n,
): JournalEntry {
  return {
    path: `f${n}.txt`,
    op: 'write',
    beforeHash: hashes.before ?? null,
    afterHash: hashes.after ?? null,
    deltaHash: hashes.delta ?? null,
    bytesDelta: 0,
    sessionId: 's',
    source: 'tool',
    toolCallId: `c${n}`,
    timestamp,
  };
}

const lineBytes = (e: JournalEntry): number =>
  Buffer.byteLength(`${serializeEntry(e)}\n`, 'utf8');

function sizes(table: Record<string, number>): (hash: string) => number {
  return (hash) => table[hash] ?? 0;
}

describe('blobHashesOf', () => {
  it.each([
    [{ before: 'b', after: 'a' }, ['b', 'a']],
    [{ before: 'b', after: 'a', delta: 'd' }, ['b', 'd']],
    [{ after: 'a' }, ['a']],
    [{ before: 'x', after: 'x' }, ['x']],
    [{}, []],
  ])('%o references %o', (hashes, expected) => {
    expect(blobHashesOf(entry(1, hashes))).toEqual(expected);
  });
});

describe('oldestTimestampOf', () => {
  it('is the minimum, not the first, and null for none', () => {
    expect(oldestTimestampOf([entry(1, {}, 5), entry(2, {}, 3)])).toBe(3);
    expect(oldestTimestampOf([])).toBeNull();
  });
});

describe('planRetention', () => {
  it('keeps everything when no bound applies', () => {
    const all = [entry(1, { after: 'a' }), entry(2, { after: 'b' })];
    const plan = planRetention(all, {}, 10, sizes({ a: 5, b: 7 }));
    expect(plan.kept).toEqual(all);
    expect([...plan.referenced].sort()).toEqual(['a', 'b']);
    expect(plan.overBound).toBe(0);
  });

  it('never aliases the entries it was given', () => {
    const all = [entry(1, { after: 'a' })];
    const plan = planRetention(all, {}, 10, sizes({ a: 1 }));
    expect(plan.kept).not.toBe(all);
  });

  it('drops entries older than the age bound', () => {
    const all = [
      entry(1, { after: 'a' }, 100),
      entry(2, { after: 'b' }, 900),
      entry(3, { after: 'c' }, 1000),
    ];
    const plan = planRetention(all, { maxAgeMs: 200 }, 1000, sizes({}));
    expect(plan.kept.map((e) => e.path)).toEqual(['f2.txt', 'f3.txt']);
    expect([...plan.referenced].sort()).toEqual(['b', 'c']);
  });

  it('counts index lines and unique blobs against the size bound', () => {
    const all = [entry(1, { after: 'a' }), entry(2, { after: 'a' })];
    const total = lineBytes(all[0]) + lineBytes(all[1]) + 100;
    // At the bound exactly: nothing drops, the shared blob counts once.
    const plan = planRetention(all, { maxBytes: total }, 0, sizes({ a: 100 }));
    expect(plan.kept).toHaveLength(2);
    expect(plan.overBound).toBe(0);
  });

  it('drops the oldest entries down to the low-water mark, a tenth below the bound', () => {
    const all = [1, 2, 3, 4, 5].map((n) => entry(n, { after: `h${n}` }));
    const blob = 1000;
    const line = lineBytes(all[0]);
    const maxBytes = 5 * (line + blob) - 1;
    const plan = planRetention(
      all,
      { maxBytes },
      0,
      sizes(Object.fromEntries(all.map((e) => [e.afterHash, blob]))),
    );
    // One drop leaves four of the five equal entries, under the low-water
    // mark (90% of the bound), so the pass stops there.
    const lowWater = maxBytes - maxBytes / 10;
    expect(4 * (line + blob)).toBeLessThanOrEqual(lowWater);
    expect(plan.kept.map((e) => e.path)).toEqual([
      'f2.txt',
      'f3.txt',
      'f4.txt',
      'f5.txt',
    ]);
    expect(plan.overBound).toBe(0);
  });

  it('keeps a blob a surviving entry still shares', () => {
    const all = [
      entry(1, { before: 'shared', after: 'old' }),
      entry(2, { before: 'shared', after: 'new' }),
    ];
    const line = lineBytes(all[0]);
    const plan = planRetention(
      all,
      { maxBytes: 2 * line + 300 - 1 },
      0,
      sizes({ shared: 100, old: 100, new: 100 }),
    );
    expect(plan.kept.map((e) => e.path)).toEqual(['f2.txt']);
    expect([...plan.referenced].sort()).toEqual(['new', 'shared']);
  });

  it('never drops the newest entry, and reports what it is still over by', () => {
    const all = [entry(1, { after: 'a' }), entry(2, { after: 'big' })];
    const plan = planRetention(
      all,
      { maxBytes: 50 },
      0,
      sizes({ a: 10, big: 500 }),
    );
    expect(plan.kept.map((e) => e.path)).toEqual(['f2.txt']);
    expect(plan.overBound).toBe(lineBytes(all[1]) + 500 - 50);
  });
});
