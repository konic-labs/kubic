// Issue #124: journal retention was O(n^2) I/O — every append stat'd every
// referenced blob (`blobBytes` over the kept set) and the byte-bound loop
// re-stat'd everything once per dropped entry. These tests count `fileInfo`
// calls through an instrumented FileBridge double. What they pin (drop set,
// ordering, removed/bytes shape) is deliberately identical to pre-change
// behavior — the retention semantics do not move; only their I/O cost does.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  type JournalEntryInput,
  sha256Hex,
} from './journal.js';

const counts = vi.hoisted(() => ({ fileInfo: 0, indexReads: 0 }));

vi.mock('./file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        fileInfo: (path: string) => {
          counts.fileInfo += 1;
          return bridge.fileInfo(path);
        },
        readTextFile: (path: string) => {
          if (path.endsWith('index.jsonl')) counts.indexReads += 1;
          return bridge.readTextFile(path);
        },
      };
    },
  };
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'journal-retention-'));
}

function entry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    path: 'src/a.ts',
    op: 'write',
    before: null,
    after: 'hello\n',
    bytesDelta: 6,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
    ...overrides,
  };
}

// Content i over M unique blobs: `content-XX` is exactly 10 bytes, so byte
// arithmetic in these tests is plain multiples of 10.
function uniqueContent(i: number): string {
  return `content-${String(i % 30).padStart(2, '0')}`;
}

describe('blob size cache (issue #124, slice 1)', () => {
  it('append #51 over 50 entries and 30 unique blobs stats zero times', () => {
    const store = new FileJournalStore(tmpRoot());
    for (let i = 0; i < 50; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    expect(store.blobCount()).toBe(30);
    counts.fileInfo = 0;
    store.append(entry({ path: 'f50.txt', after: uniqueContent(50) }));
    // Before the size cache this append stat'd every unique referenced blob
    // (30 here, growing per entry); sizes recorded at write time make it 0.
    expect(counts.fileInfo).toBe(0);
  });
});

describe('retention reference counting (issue #124, slice 2)', () => {
  it('dropping the older of two entries sharing a before-blob keeps the shared blob', () => {
    const store = new FileJournalStore(tmpRoot());
    store.append(
      entry({
        path: 'a.txt',
        before: 'shared\n',
        after: 'x1\n',
        bytesDelta: -4,
      }),
    );
    store.append(
      entry({
        path: 'b.txt',
        before: 'shared\n',
        after: 'x2\n',
        bytesDelta: -4,
      }),
    );
    expect(store.blobCount()).toBe(3);
    const pruned = store.enforceRetention({ maxBytes: 10 });
    // The freed bytes are exactly the older entry's unique blob: the shared
    // before-blob survives because b.txt still references it.
    expect(pruned).toEqual({ entries: 1, bytes: 3 });
    expect(store.entries().map((e) => e.path)).toEqual(['b.txt']);
    expect(store.hasBlob(sha256Hex('shared\n'))).toBe(true);
    expect(store.hasBlob(sha256Hex('x1\n'))).toBe(false);
    expect(store.blobCount()).toBe(2);
  });

  it('dropping both entries sharing a before-blob frees it, counted once in bytes', () => {
    const store = new FileJournalStore(tmpRoot());
    store.append(
      entry({
        path: 'a.txt',
        before: 'shared\n',
        after: 'x1\n',
        bytesDelta: -4,
      }),
    );
    store.append(
      entry({
        path: 'b.txt',
        before: 'shared\n',
        after: 'x2\n',
        bytesDelta: -4,
      }),
    );
    const pruned = store.enforceRetention({ maxBytes: 3 });
    // 13 unique bytes referenced, 7 of them the shared blob counted once —
    // pins both the drop set and the refcounted byte arithmetic.
    expect(pruned).toEqual({ entries: 2, bytes: 13 });
    expect(store.entries()).toEqual([]);
    expect(store.blobCount()).toBe(0);
  });
});

describe('retention fast path (issue #124, slice 2)', () => {
  it('100 appends far under the bound pay zero per-append retention I/O', () => {
    const store = new FileJournalStore(tmpRoot(), {
      maxBytes: 10 * 1024 * 1024,
    });
    counts.fileInfo = 0;
    counts.indexReads = 0;
    for (let i = 0; i < 100; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    const M = 30; // unique blobs
    const prunes = 0;
    // Stats converge to 0 at any session length: at most M + prunes.
    expect(counts.fileInfo).toBeLessThanOrEqual(M + prunes);
    expect(counts.fileInfo).toBe(0);
    // And the pass is skipped outright: no per-append index reads — one
    // seeding pass at most, never one scan per append.
    expect(counts.indexReads).toBeLessThanOrEqual(2);
  });

  it('a forced prune takes the slow path and computes the same drop set as before', () => {
    const store = new FileJournalStore(tmpRoot(), {
      maxBytes: 10 * 1024 * 1024,
    });
    for (let i = 0; i < 100; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    const pruned = store.enforceRetention({ maxBytes: 20 });
    // Drop-oldest-first until the unique blob bytes fit — the same drop set
    // the pre-change arithmetic produced.
    expect(pruned).toEqual({ entries: 98, bytes: 280 });
    expect(store.entries().map((e) => e.path)).toEqual(['f98.txt', 'f99.txt']);
    expect(store.blobCount()).toBe(2);
  });
});

describe('prune stats bound (issue #124, slice 2)', () => {
  it('a genuine prune on a cold store stats at most once per unique blob', () => {
    const dir = tmpRoot();
    const seed = new FileJournalStore(dir);
    for (let i = 0; i < 50; i++) {
      seed.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    expect(seed.blobCount()).toBe(30);
    const cold = new FileJournalStore(dir); // fresh instance, no cache warmth
    counts.fileInfo = 0;
    const pruned = cold.enforceRetention({ maxBytes: 150 });
    // 35 drops over 30 unique blobs: at most one stat per unique blob
    // total, never drops × M.
    expect(counts.fileInfo).toBeLessThanOrEqual(30);
    expect(pruned).toEqual({ entries: 35, bytes: 150 });
    expect(cold.entries().map((e) => e.path)).toEqual(
      Array.from({ length: 15 }, (_, k) => `f${k + 35}.txt`),
    );
    expect(cold.blobCount()).toBe(15);
  });
});
