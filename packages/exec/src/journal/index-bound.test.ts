// Journal byte bound includes the index ("bounded by size
// and age with configurable limits").
//
// Content addressing dedupes blobs, so a file toggling between two contents —
// a formatter fighting the agent, repeated undo --step — adds a few hundred
// index bytes per append while blob bytes stay flat. Counting only blobs left
// index.jsonl unbounded, which contradicts "unbounded growth is impossible by
// construction" (journal.ts header). The bound is the whole store now: the
// index's own size plus the blob bytes it references.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { FileJournalStore } from './store.js';
import type { JournalEntryInput } from './types.js';

function entry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    path: 'src/a.ts',
    op: 'write',
    before: null,
    after: 'hello\n',
    bytesDelta: 6,
    sessionId: 's1',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
    ...overrides,
  };
}

function storeBytes(dir: string): number {
  const index = statSync(join(dir, 'index.jsonl')).size;
  let blobs = 0;
  for (const name of readdirSync(join(dir, 'blobs'))) {
    blobs += statSync(join(dir, 'blobs', name)).size;
  }
  return index + blobs;
}

describe('journal index size counts against the bound', () => {
  it('keeps index + blobs under the bound across 10k alternating appends', () => {
    const dir = tempDir('journal-index-bound-');
    const store = new FileJournalStore(dir, {
      maxBytes: 64 * 1024,
      durable: false,
    });
    for (let i = 0; i < 10_000; i += 1) {
      store.append(
        entry({
          path: 'toggling.txt',
          after: i % 2 === 0 ? 'a\n' : 'b\n',
          bytesDelta: 0,
          timestamp: 1_700_000_000_000 + i,
        }),
      );
    }
    // Two blobs at most ('a\n' and 'b\n'), and an index that stays bounded
    // instead of growing by ~300 bytes per append forever.
    expect(store.blobCount()).toBe(2);
    expect(storeBytes(dir)).toBeLessThanOrEqual(64 * 1024);
    expect(store.entries().length).toBeGreaterThan(0);
  }, 30_000);

  it('leaves a tenth of the bound free, not a tenth of the entries', () => {
    const dir = tempDir('journal-index-bound-');
    // Build well over the bound: the drop set is forced, so the pass has to
    // decide how much headroom to buy back.
    const store = new FileJournalStore(dir, { durable: false });
    for (let i = 0; i < 40; i += 1) {
      store.append(
        entry({
          path: `f${i}.txt`,
          after: `${'x'.repeat(400)}${i}\n`,
          bytesDelta: 0,
          timestamp: 1_700_000_000_000 + i,
        }),
      );
    }
    const full = storeBytes(dir);
    const maxBytes = Math.floor(full / 2);
    const pruned = store.enforceRetention({ maxBytes });
    expect(pruned.entries).toBeGreaterThan(0);
    // The pass stops a tenth of the BOUND below the cap (the headroom the
    // next appends need), not a tenth of the entries above it — dropping to
    // just under `maxBytes` would leave the next append rewriting the index.
    expect(storeBytes(dir)).toBeLessThanOrEqual(maxBytes * 0.9);
    // And it still keeps the newest entry, as ever.
    expect(store.entries().length).toBeGreaterThan(0);
  });

  it('drops the oldest entry when only the index pushes the store over', () => {
    const dir = tempDir('journal-index-bound-');
    const store = new FileJournalStore(dir, { maxBytes: 2000, durable: false });
    // One small blob, reused: the store grows through its index lines alone.
    for (let i = 0; i < 40; i += 1) {
      store.append(
        entry({
          path: `f${i}.txt`,
          after: 'same\n',
          bytesDelta: 0,
          timestamp: 1_700_000_000_000 + i,
        }),
      );
    }
    expect(store.blobCount()).toBe(1);
    expect(storeBytes(dir)).toBeLessThanOrEqual(2000);
    // The newest entry survives, as always.
    expect(store.entries().at(-1)?.path).toBe('f39.txt');
    expect(store.entries().length).toBeLessThan(40);
  });

  it('still takes the fast path while index + blobs stay under the bound', () => {
    const dir = tempDir('journal-index-bound-');
    const store = new FileJournalStore(dir, { maxBytes: 64 * 1024 });
    for (let i = 0; i < 5; i += 1) {
      store.append(entry({ path: `f${i}.txt`, after: 'small\n' }));
    }
    expect(store.entries()).toHaveLength(5);
    expect(storeBytes(dir)).toBeLessThanOrEqual(64 * 1024);
  });
});
