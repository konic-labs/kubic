// Issue #124: journal retention was O(n^2) I/O — every append stat'd every
// referenced blob (`blobBytes` over the kept set) and the byte-bound loop
// re-stat'd everything once per dropped entry. These tests count `fileInfo`
// calls through an instrumented FileBridge double. What they pin (drop set,
// ordering, removed/bytes shape) is deliberately identical to pre-change
// behavior — the retention semantics do not move; only their I/O cost does.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// Live-stat truth: the unique blob bytes the index references right now.
// A missing blob counts zero — exactly what the pre-#124 `blobBytes` saw.
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

describe('blob size cache (issue #124, slice 1)', () => {
  it('append #51 over 50 entries and 30 unique blobs stats zero times', () => {
    const store = new FileJournalStore(tmpRoot(), FAST);
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
      ...FAST,
      maxBytes: 10 * 1024 * 1024,
    });
    counts.fileInfo = 0;
    counts.indexReads = 0;
    for (let i = 0; i < 100; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    // Sizes are recorded at write time and no prune runs: zero stats.
    expect(counts.fileInfo).toBe(0);
    // And the pass is skipped outright: no per-append index reads — one
    // seeding pass at most, never one scan per append.
    expect(counts.indexReads).toBeLessThanOrEqual(2);
  });

  it('a forced prune takes the slow path and computes the same drop set as before', () => {
    const store = new FileJournalStore(tmpRoot(), {
      ...FAST,
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
    const seed = new FileJournalStore(dir, FAST);
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

// Review finding 1: `append` with the reconcile shape (before: null plus a
// hash-only beforeHash) never accounted that hash's bytes, so an existing
// but unaccounted blob (crash-residue orphan from a putBlob-then-failed
// appendFile, or a sweep's best-effort remove leak) made trackedBytes
// under-count — and the fast path then skipped pruning passes while the
// journal grew past its bound. The pre-change code stayed bounded after
// every append; this must too.
describe('hash-only before refs are tracked (issue #124, review finding 1)', () => {
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
      // Bounded by construction: the pre-change code kept the journal
      // within its bound after EVERY append, and so must this one.
      expect(referencedBytes(dir, store)).toBeLessThanOrEqual(maxBytes);
    }
    // Pruning passes must have run — 11 entries of 60 referenced bytes
    // cannot all survive a 300-byte bound.
    expect(store.entries().length).toBeLessThan(11);
  });
});

// Review finding 2: the blob size cache is write-once per hash and never
// revalidated, so external mutation of a blob file (replacement with
// different-length content, or deletion) leaves stale/phantom sizes that
// corrupt the drop set — a phantom size drops entries the old live-stat
// loop kept (a missing blob counted zero) — and inflate the returned bytes.
// The pre-change code live-statted every pass; a slow pass must re-derive
// its truth the same way.
describe('slow passes re-stat referenced blobs (issue #124, review finding 2)', () => {
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
    // replaced with different-length content. Live truth is now
    // 0 + 6 + 100 = 106 — exactly at the bound below, so the old live-stat
    // code drops nothing. Cached (phantom) sizes of 100 each would inflate
    // the derived total to 300 and corrupt the drop set.
    rmSync(join(dir, 'blobs', e0.afterHash ?? ''));
    writeFileSync(join(dir, 'blobs', e1.afterHash ?? ''), 'short\n');
    const pruned = store.enforceRetention({ maxBytes: 106 });
    expect(pruned).toEqual({ entries: 0, bytes: 0 });
    expect(store.entries().map((e) => e.path)).toEqual([
      'f0.txt',
      'f1.txt',
      'f2.txt',
    ]);
    // The tighter bound forces exactly the live-truth drop set: f0 first
    // (its blob is gone — dropping it frees nothing), then f1 (frees its
    // live 6 bytes), never f2. The freed bytes are live truth, not phantoms.
    const prunedMore = store.enforceRetention({ maxBytes: 100 });
    expect(prunedMore).toEqual({ entries: 2, bytes: 6 });
    expect(store.entries().map((e) => e.path)).toEqual(['f2.txt']);
  });
});
