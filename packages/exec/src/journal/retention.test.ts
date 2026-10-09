// Journal retention was O(n^2) I/O — every append stat'd every
// referenced blob (`blobBytes` over the kept set) and the byte-bound loop
// re-stat'd everything once per dropped entry. These tests count `fileInfo`
// calls through an instrumented FileBridge double. What they pin (drop set,
// ordering, removed/bytes shape) must stay exact: the retention semantics
// do not move; only their I/O cost does.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileBridge } from '../file-bridge.js';
import { sha256Hex } from './hash.js';
import { FileJournalStore } from './store.js';
import type { JournalEntryInput } from './types.js';

const counts = vi.hoisted(() => ({ fileInfo: 0, blobInfo: 0, indexReads: 0 }));

vi.mock('../file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        fileInfo: (path: string) => {
          counts.fileInfo += 1;
          // Blob stats are the O(M) cost under test; the append's
          // own index tail probe is one lstat per append and
          // is deliberately not counted here.
          if (path.includes(`${'/'}blobs${'/'}`)) counts.blobInfo += 1;
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-retention-'));
  roots.push(root);
  return root;
}

// These tests count retention I/O (stats, index reads), which the fsync'd
// index append does not touch — `durable: false` drops ~one fsync per append
// from the many-append fixtures without changing what is measured.
const FAST = { durable: false } as const;

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

// Content i over M unique blobs: `content-XX` is exactly 10 bytes, so byte
// arithmetic in these tests is plain multiples of 10.
function uniqueContent(i: number): string {
  return `content-${String(i % 30).padStart(2, '0')}`;
}

// Live-stat truth: the unique blob bytes the index references right now.
// A missing blob counts zero — exactly what the pre `blobBytes` saw.
function referencedBytes(dir: string, store: FileJournalStore): number {
  const seen = new Set<string>();
  let total = 0;
  for (const e of store.entries()) {
    for (const hash of [e.beforeHash, e.deltaHash ?? e.afterHash]) {
      if (hash === null || seen.has(hash)) continue;
      seen.add(hash);
      try {
        total += statSync(join(dir, 'blobs', hash)).size;
      } catch {
        // Missing blob: zero bytes on disk.
      }
    }
  }
  return total;
}

describe('swept orphan blobs', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ORPHAN_BYTES = 19;
  const orphanHash = sha256Hex('orphan content');

  // A store holding one aged and one fresh entry. `withOrphan` also writes a
  // blob file no entry references, an hour old, so a sweep may take it.
  function seeded(
    now: number,
    withOrphan: boolean,
  ): { store: FileJournalStore; dir: string } {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, FAST);
    store.append(
      entry({
        path: 'old.txt',
        after: 'old-content\n',
        bytesDelta: 12,
        timestamp: now - 30 * DAY,
      }),
    );
    store.append(
      entry({
        path: 'new.txt',
        after: 'new-content\n',
        bytesDelta: 12,
        timestamp: now,
      }),
    );
    if (withOrphan) {
      const path = join(dir, 'blobs', orphanHash);
      writeFileSync(path, 'x'.repeat(ORPHAN_BYTES));
      const hourAgo = new Date(now - 60 * 60 * 1000);
      utimesSync(path, hourAgo, hourAgo);
    }
    return { store, dir };
  }

  it('the freed bytes include the orphan blob the sweep removes', () => {
    const now = Date.now();
    const plain = seeded(now, false).store.enforceRetention({
      maxAgeMs: 7 * DAY,
      now,
    });
    const { store, dir } = seeded(now, true);
    const swept = store.enforceRetention({ maxAgeMs: 7 * DAY, now });
    expect(plain.entries).toBe(1);
    expect(swept.entries).toBe(1);
    expect(existsSync(join(dir, 'blobs', orphanHash))).toBe(false);
    expect(swept.bytes).toBe(plain.bytes + ORPHAN_BYTES);
  });

  it('a pass that drops nothing sweeps nothing, so an orphan survives it', () => {
    const now = Date.now();
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, FAST);
    store.append(
      entry({
        path: 'new.txt',
        after: 'new-content\n',
        bytesDelta: 12,
        timestamp: now,
      }),
    );
    const path = join(dir, 'blobs', orphanHash);
    writeFileSync(path, 'x'.repeat(ORPHAN_BYTES));
    const hourAgo = new Date(now - 60 * 60 * 1000);
    utimesSync(path, hourAgo, hourAgo);
    expect(store.enforceRetention({ maxAgeMs: 7 * DAY, now })).toEqual({
      entries: 0,
      bytes: 0,
      overBound: 0,
    });
    expect(existsSync(path)).toBe(true);
  });
});

describe('blob size cache', () => {
  it('append over 50 entries and 30 unique blobs stats zero times', () => {
    const store = new FileJournalStore(tmpRoot(), FAST);
    for (let i = 0; i < 50; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    expect(store.blobCount()).toBe(30);
    counts.blobInfo = 0;
    store.append(entry({ path: 'f50.txt', after: uniqueContent(50) }));
    // Before the size cache this append stat'd every unique referenced blob
    // (30 here, growing per entry). Now the only stat is the integrity check
    // on the ONE blob the append is about to reuse — content-20
    // already exists — never the referenced set.
    expect(counts.blobInfo).toBe(1);
  });
});

describe('retention reference counting', () => {
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
    // before-blob survives because b.txt still references it. The kept line
    // alone is over the 10-byte bound, so the
    // excess is reported rather than hidden.
    expect(pruned.entries).toBe(1);
    expect(pruned.bytes).toBe(3);
    expect(pruned.overBound).toBeGreaterThan(0);
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
    // The newest entry is never dropped, so the shared blob's
    // last reference is released by dropping the two older ones.
    store.append(entry({ path: 'c.txt', after: 'c\n' }));
    const pruned = store.enforceRetention({ maxBytes: 2 });
    // 15 unique blob bytes referenced, 7 of them the shared blob counted
    // once — pins both the drop set and the refcounted byte arithmetic. The
    // kept line is over the 2-byte bound (the index counts).
    expect(pruned.entries).toBe(2);
    expect(pruned.bytes).toBe(13);
    expect(pruned.overBound).toBeGreaterThan(0);
    expect(store.entries().map((e) => e.path)).toEqual(['c.txt']);
    expect(store.hasBlob(sha256Hex('shared\n'))).toBe(false);
    expect(store.blobCount()).toBe(1);
  });
});

describe('retention fast path', () => {
  it('100 appends far under the bound pay zero per-append retention I/O', () => {
    const store = new FileJournalStore(tmpRoot(), {
      ...FAST,
      maxBytes: 10 * 1024 * 1024,
    });
    counts.blobInfo = 0;
    counts.indexReads = 0;
    for (let i = 0; i < 100; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    // Sizes are recorded at write time and no prune runs: the only blob
    // stat is the integrity check on a blob the append is about to
    // reuse — at most one per append, never the 30-strong referenced set.
    expect(counts.blobInfo).toBeLessThanOrEqual(100);
    // And the pass is skipped outright: no per-append index reads — one
    // seeding pass at most, never one scan per append.
    expect(counts.indexReads).toBeLessThanOrEqual(2);
  });

  it('a forced prune takes the slow path and drops down to the whole-store bound', () => {
    const store = new FileJournalStore(tmpRoot(), {
      ...FAST,
      maxBytes: 10 * 1024 * 1024,
    });
    for (let i = 0; i < 100; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    const pruned = store.enforceRetention({ maxBytes: 20 });
    // Drop-oldest-first until the store fits — the bound counts the index's
    // own lines as well as the blobs, so with 20 bytes only the
    // newest entry survives. The freed bytes are its 290 blob bytes: the
    // refcounted arithmetic is unchanged, the bound is not.
    expect(pruned.entries).toBe(99);
    expect(pruned.bytes).toBe(290);
    expect(store.entries().map((e) => e.path)).toEqual(['f99.txt']);
    expect(store.blobCount()).toBe(1);
  });
});

describe('retention fast path with an age policy', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('100 appends with an age policy read the index at most once', () => {
    const store = new FileJournalStore(tmpRoot(), {
      ...FAST,
      maxBytes: 10 * 1024 * 1024,
      maxAgeMs: 7 * DAY_MS,
    });
    counts.indexReads = 0;
    for (let i = 0; i < 100; i++) {
      // Stamped now, so the 7-day window is what the cached oldest proves.
      store.append(
        entry({
          path: `f${i}.txt`,
          after: uniqueContent(i),
          timestamp: Date.now(),
        }),
      );
    }
    // The first pass seeds the oldest timestamp; every later append proves
    // from cache that nothing can have aged out (7 days against a session
    // that is milliseconds old), so the whole index is never re-read.
    expect(counts.indexReads).toBeLessThanOrEqual(1);
  });

  it('prunes an entry that crosses the age boundary on the next append', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, {
      maxBytes: 10 * 1024 * 1024,
      maxAgeMs: 1000,
    });
    // Pin the wall clock so the boundary is crossed without a sleep.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      store.append(
        entry({ path: 'aged.txt', after: 'a\n', timestamp: 1_000_000 }),
      );
      expect(store.entries().map((e) => e.path)).toEqual(['aged.txt']);
      // The window passes; the next append's pass must notice, even though
      // the fast path was the state it left behind.
      vi.setSystemTime(1_005_000);
      store.append(
        entry({ path: 'fresh.txt', after: 'f\n', timestamp: 1_005_000 }),
      );
      expect(store.entries().map((e) => e.path)).toEqual(['fresh.txt']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('folds an out-of-order append into the cached oldest timestamp', () => {
    const store = new FileJournalStore(tmpRoot(), {
      maxBytes: 10 * 1024 * 1024,
      maxAgeMs: 1000,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Seed the cache with a fresh entry: the pass proves the window from
      // cache and leaves oldestTimestamp at "now".
      vi.setSystemTime(1_000_000);
      store.append(entry({ path: 'fresh.txt', after: 'f\n' }));
      expect(store.entries().map((e) => e.path)).toEqual(['fresh.txt']);
      // A backwards clock step appends an entry already outside the window.
      // The cache must fold to its stamp, or the next pass proves "nothing
      // aged out" from a minimum that is higher than the truth.
      store.append(
        entry({
          path: 'stale.txt',
          after: 's\n',
          timestamp: 1_000_000 - 5_000,
        }),
      );
      store.append(entry({ path: 'after.txt', after: 'a\n' }));
      expect(store.entries().map((e) => e.path)).toEqual([
        'fresh.txt',
        'after.txt',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pruning on later appends once the boundary has been crossed', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, {
      maxBytes: 10 * 1024 * 1024,
      maxAgeMs: 15_000,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    counts.indexReads = 0;
    try {
      vi.setSystemTime(2_000_000);
      store.append(
        entry({ path: 'a.txt', after: 'a\n', timestamp: 2_000_000 }),
      );
      const r1 = counts.indexReads;
      // Ten seconds later a.txt is still inside the 15-second window: the
      // cached oldest proves it and the pass is skipped.
      vi.setSystemTime(2_010_000);
      store.append(
        entry({ path: 'b.txt', after: 'b\n', timestamp: 2_010_000 }),
      );
      const r2 = counts.indexReads;
      // Twenty seconds after a.txt, the boundary is crossed: the pass runs
      // and drops it while keeping b.txt and c.txt.
      vi.setSystemTime(2_020_000);
      store.append(
        entry({ path: 'c.txt', after: 'c\n', timestamp: 2_020_000 }),
      );
      expect(store.entries().map((e) => e.path)).toEqual(['b.txt', 'c.txt']);
      // One read seeds the cache; the middle append adds none — it proved the
      // window from cache, which is the whole point of the age fast path. The
      // crossing pass is the only other reader (one read for the entries, one
      // for its post-rewrite re-seed). Without the fast path every append is a
      // slow pass: [1, 2, 4] instead of [1, 1, 3].
      expect([r1, r2, counts.indexReads]).toEqual([1, 1, 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('prune stats bound', () => {
  it('a genuine prune on a cold store stats at most once per unique blob', () => {
    const dir = tmpRoot();
    const seed = new FileJournalStore(dir, FAST);
    for (let i = 0; i < 50; i++) {
      seed.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    expect(seed.blobCount()).toBe(30);
    const cold = new FileJournalStore(dir); // fresh instance, no cache warmth
    counts.fileInfo = 0;
    counts.blobInfo = 0;
    // The whole-store bound (index lines + blobs) with 150 bytes
    // leaves only the newest entry.
    const pruned = cold.enforceRetention({ maxBytes: 150 });
    // 49 drops over 30 unique blobs: at most one BLOB stat per unique blob
    // total, never drops × M. (The pass's own index stats — the read-time
    // size and the unchanged-check before the rename — are not
    // blob stats and are counted separately.)
    expect(counts.blobInfo).toBeLessThanOrEqual(30);
    expect(pruned.entries).toBe(49);
    expect(pruned.bytes).toBe(290);
    expect(cold.entries().map((e) => e.path)).toEqual(['f49.txt']);
    expect(cold.blobCount()).toBe(1);
  });
});

// `append` with the reconcile shape (before: null plus a hash-only beforeHash)
// must account that hash's bytes. An existing but unaccounted blob (crash-residue
// orphan from a putBlob-then-failed appendFile, or a sweep's best-effort remove
// leak) must not make trackedBytes under-count: the fast path would skip pruning
// passes while the journal grew past its bound. Every append keeps it bounded.
describe('hash-only before refs are tracked', () => {
  it('reconcile-shaped appends over unaccounted orphan blobs stay within maxBytes after every append', () => {
    const dir = tmpRoot();
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    // Orphans: blobs on disk no pass ever accounted — 50 bytes each.
    const orphanHashes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const content = `orphan-${String(i).padStart(2, '0')}`.padEnd(50, '.');
      orphanHashes.push(sha256Hex(content));
      writeFileSync(join(dir, 'blobs', sha256Hex(content)), content);
    }
    const maxBytes = 300;
    const store = new FileJournalStore(dir, { maxBytes });
    // Seeding append: does not reference any orphan.
    store.append(entry({ path: 'seed.txt', after: uniqueContent(29) }));
    for (let i = 0; i < 10; i++) {
      // Reconcile record() shape: no before-content, hash-only pre-image
      // naming an orphan that IS real referenced storage on disk.
      store.append(
        entry({
          path: `r${i}.txt`,
          before: null,
          beforeHash: orphanHashes[i],
          after: uniqueContent(i + 10),
          unattributed: true,
        }),
      );
      // Bounded by construction: the journal stays within its bound after EVERY append.
      expect(referencedBytes(dir, store)).toBeLessThanOrEqual(maxBytes);
    }
    // Pruning passes must have run — 11 entries of 60 referenced bytes
    // cannot all survive a 300-byte bound.
    expect(store.entries().length).toBeLessThan(11);
  });
});

// The blob size cache is write-once per hash and never
// revalidated, so external mutation of a blob file (replacement with
// different-length content, or deletion) leaves stale/phantom sizes that
// corrupt the drop set — a phantom size drops entries a live stat would keep
// (a missing blob counted zero) — and inflate the returned bytes.
// A slow pass must re-derive its truth by live-statting every referenced blob.
describe('slow passes re-stat referenced blobs', () => {
  it('external blob mutation never corrupts the drop set or the reported freed bytes', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const c0 = 'c0'.padEnd(100, '0'); // exactly 100 bytes
    const c1 = 'c1'.padEnd(100, '1');
    const c2 = 'c2'.padEnd(100, '2');
    const e0 = store.append(entry({ path: 'f0.txt', after: c0 }));
    const e1 = store.append(entry({ path: 'f1.txt', after: c1 }));
    store.append(entry({ path: 'f2.txt', after: c2 }));
    // External mutation between passes: f0's blob vanishes, f1's blob is
    // replaced with different-length content. Live truth is now 0 + 6 + 100
    // = 106 blob bytes — set the bound to exactly the store's live size
    // (index lines included), so live-stat truth drops nothing.
    // Cached (phantom) sizes of 100 each would inflate the derived total to
    // 300 and corrupt the drop set.
    rmSync(join(dir, 'blobs', e0.afterHash ?? ''));
    writeFileSync(join(dir, 'blobs', e1.afterHash ?? ''), 'short\n');
    const indexBytes = store
      .entries()
      .reduce(
        (total, e) =>
          total + Buffer.byteLength(`${JSON.stringify(e)}\n`, 'utf8'),
        0,
      );
    const pruned = store.enforceRetention({ maxBytes: indexBytes + 106 });
    expect(pruned).toEqual({ entries: 0, bytes: 0, overBound: 0 });
    expect(store.entries().map((e) => e.path)).toEqual([
      'f0.txt',
      'f1.txt',
      'f2.txt',
    ]);
    // The tighter bound forces exactly the live-truth drop set: f0 first
    // (its blob is gone — dropping it frees nothing), then f1 (frees its
    // live 6 bytes), never f2. The freed bytes are live truth, not phantoms.
    const prunedMore = store.enforceRetention({ maxBytes: 100 });
    expect(prunedMore.entries).toBe(2);
    expect(prunedMore.bytes).toBe(6);
    expect(prunedMore.overBound).toBeGreaterThan(0);
    expect(store.entries().map((e) => e.path)).toEqual(['f2.txt']);
  });
});
