// Content-addressed journal store.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureBaseline } from './baseline.js';
import { applyDelta, encodeDelta } from './delta.js';
import type { GitCommand } from './git.js';
import { sha256Hex } from './hash.js';
import { restoreEntry } from './restore.js';
import { FileJournalStore } from './store.js';
import { reconcile } from './sweep.js';
import type { JournalEntry, JournalEntryInput } from './types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix = 'journal-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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

describe('journal store', () => {
  it('appends entries and reads them back with hashes and toolCallId', () => {
    const store = new FileJournalStore(tmpRoot());
    const recorded = store.append(entry());
    expect(recorded.beforeHash).toBe(null);
    expect(recorded.afterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.toolCallId).toBe('call-1');
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('src/a.ts');
  });

  it('stores blobs content-addressed: identical content written once', () => {
    const store = new FileJournalStore(tmpRoot());
    store.append(entry({ path: 'a.txt', after: 'same\n' }));
    store.append(entry({ path: 'b.txt', after: 'same\n' }));
    expect(store.blobCount()).toBe(1);
  });

  it('tolerates corrupt index lines', () => {
    const store = new FileJournalStore(tmpRoot());
    store.append(entry());
    appendFileSync(store.indexPath, '{torn\n');
    store.append(entry({ path: 'b.txt' }));
    expect(store.entries().map((e) => e.path)).toEqual(['src/a.ts', 'b.txt']);
  });

  it('round-trips the line delta codec, including edge cases', () => {
    for (const [before, after] of [
      ['', ''],
      ['a\n', 'a\n'],
      ['a\n', 'a\nb\n'],
      ['a\nb\nc\n', 'a\nx\nc\nd\n'],
      ['gone\n', ''],
    ] as Array<[string, string]>) {
      expect(applyDelta(before, encodeDelta(before, after))).toBe(after);
    }
  });

  it('stores a delta — never a full after-blob — for large files', () => {
    const store = new FileJournalStore(tmpRoot());
    const before = `${'line\n'.repeat(20_000)}tail\n`;
    const after = `${'line\n'.repeat(20_000)}TAIL\n`;
    const recorded = store.append(
      entry({ path: 'big.txt', before, after, bytesDelta: 0 }),
    );
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    // The full after-content must not exist as a blob.
    expect(store.hasBlob(recorded.afterHash ?? '')).toBe(false);
    // Reconstruction from the before-blob plus the delta is exact.
    const rebuilt = store.readAfter(recorded);
    expect(rebuilt).toBe(after);
  });

  it('restores before-content for undo, including delta-recorded edits', () => {
    const store = new FileJournalStore(tmpRoot());
    const before = `${'line\n'.repeat(20_000)}tail\n`;
    const after = `${'line\n'.repeat(20_000)}changed\n`;
    const recorded = store.append(
      entry({
        path: 'big.txt',
        before,
        after,
        bytesDelta: after.length - before.length,
      }),
    );
    // The edit really was delta-recorded (no full after-blob)...
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    // ...and undo still gets the exact pre-image back.
    expect(store.readBefore(recorded)).toBe(before);
  });

  it('applyDelta returns null on malformed delta JSON instead of throwing', () => {
    // Hash-valid but malformed deltas must never crash a caller: torn content
    // that happens to parse-check fails closed to null, and callers treat it as
    // missing.
    expect(applyDelta('a\n', '{torn')).toBe(null);
  });

  it('bounds growth by default: appends enforce the store limits', () => {
    const store = new FileJournalStore(tmpRoot(), { maxBytes: 12 });
    store.append(entry({ path: 'a.txt', after: 'aaaaaa\n' }));
    store.append(entry({ path: 'b.txt', after: 'bbbbbb\n' }));
    const paths = store.entries().map((e) => e.path);
    expect(paths).toEqual(['b.txt']);
    expect(store.blobCount()).toBe(1);
  });

  it('enforces retention: size evicts oldest, age evicts stale, blobs unreferenced are dropped', () => {
    const store = new FileJournalStore(tmpRoot());
    store.append(entry({ path: 'old.txt', after: 'old\n', timestamp: 1000 }));
    store.append(entry({ path: 'new.txt', after: 'new\n', timestamp: 2000 }));
    const pruned = store.enforceRetention({ maxAgeMs: 500, now: 2000 });
    expect(pruned.entries).toBe(1);
    // Freed bytes are the dropped entry's unique blob ('old\n'), live truth.
    expect(pruned.bytes).toBe(4);
    expect(store.entries()[0]?.path).toBe('new.txt');
    expect(store.blobCount()).toBe(1);

    // Size: the oldest is evicted, and the newest entry is never dropped — its
    // excess over the whole-store bound (index + blobs) is reported instead.
    store.append(entry({ path: 'newest.txt', after: 'nw\n', timestamp: 3000 }));
    const small = store.enforceRetention({ maxBytes: 1, now: 2000 });
    expect(small.entries).toBe(1);
    expect(small.overBound).toBeGreaterThan(0);
    expect(store.entries().map((e) => e.path)).toEqual(['newest.txt']);
    expect(store.blobCount()).toBe(1);
  });
});

// Blob integrity: the delta base is recorded, never guessed.
describe('deltaBaseEmpty schema', () => {
  const big = `${'line\n'.repeat(20_000)}tail\n`;

  it('append records deltaBaseEmpty when the delta is encoded against an empty before', () => {
    const store = new FileJournalStore(tmpRoot());
    const recorded = store.append(
      entry({ path: 'big.txt', before: null, after: big, bytesDelta: 0 }),
    );
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.deltaBaseEmpty).toBe(true);
    expect(store.entries()[0]?.deltaBaseEmpty).toBe(true);
  });

  it('append leaves deltaBaseEmpty absent on tool-authored deltas with real before-content', () => {
    const store = new FileJournalStore(tmpRoot());
    const recorded = store.append(
      entry({
        path: 'big.txt',
        before: `head\n${big}`,
        after: big,
        bytesDelta: 0,
      }),
    );
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.deltaBaseEmpty).toBe(undefined);
    expect(store.entries()[0]?.deltaBaseEmpty).toBe(undefined);
  });
});

// Blob integrity: readAfter reconstructs from the recorded
// base, never from a guess.
describe('readAfter delta bases', () => {
  const big = `${'r\n'.repeat(40_000)}tail\n`;

  it('a reconcile-authored large-file entry reconstructs from its recorded empty base', () => {
    // reconcile's record() shape: no before-content, hash-only pre-image.
    const store = new FileJournalStore(tmpRoot());
    const recorded = store.append(
      entry({
        path: 'big.txt',
        op: 'write',
        before: null,
        beforeHash: sha256Hex('gone\n'),
        after: big,
        bytesDelta: 0,
        unattributed: true,
      }),
    );
    expect(recorded.deltaBaseEmpty).toBe(true);
    expect(store.readAfter(recorded)).toBe(big);
  });

  it('legacy unattributed entries without the flag keep reconstructing from the empty base', () => {
    // A pre-schema entry: same data as a reconcile large-file find, but
    // written before deltaBaseEmpty existed. Correct-by-construction today
    // (reconcile is the only writer of that shape) and must stay so.
    const dir = tmpRoot();
    const delta = encodeDelta('', big);
    const deltaHash = sha256Hex(delta);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'blobs', deltaHash), delta);
    const legacy: JournalEntry = {
      source: 'tool',
      path: 'legacy.txt',
      op: 'write',
      beforeHash: sha256Hex('gone\n'),
      afterHash: sha256Hex(big),
      deltaHash,
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 1,
      unattributed: true,
    };
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(legacy)}\n`);
    const store = new FileJournalStore(dir);
    const entry0 = store.entries()[0];
    expect(entry0?.deltaBaseEmpty).toBe(undefined);
    expect(store.readAfter(entry0 ?? legacy)).toBe(big);
  });

  it('a pre-flag unattributed entry with a shared before-hash reconstructs from the empty base', () => {
    // The legacy heuristic must outrank the before-blob branch: unattributed
    // entries carry a hash-only beforeHash, and when that hash resolves to a
    // SHARED blob (another entry journaled the same bytes), applying the
    // base-'' delta against the shared content silently serves wrong
    // after-content with no corruption reported.
    const dir = tmpRoot();
    const shared = 'shared\ncontent\n';
    const after = 'real\nafter\n';
    const delta = encodeDelta('', after);
    const deltaHash = sha256Hex(delta);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'blobs', deltaHash), delta);
    const legacy: JournalEntry = {
      source: 'tool',
      path: 'legacy.txt',
      op: 'write',
      beforeHash: sha256Hex(shared),
      afterHash: sha256Hex(after),
      deltaHash,
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 1,
      unattributed: true,
    };
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(legacy)}\n`);
    const store = new FileJournalStore(dir);
    // Another entry journaled the same bytes as after-content, so the blob
    // now exists at the legacy entry's beforeHash.
    store.append(entry({ path: 'other.txt', after: shared }));
    expect(store.hasBlob(sha256Hex(shared))).toBe(true);
    const entry0 = store.entries()[0];
    expect(entry0?.deltaBaseEmpty).toBe(undefined);
    expect(store.readAfter(entry0 ?? legacy)).toBe(after);
  });

  it('a deltaBaseEmpty reconstruction never reads its before-blob (no corrupt report for an unused torn blob)', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(
      entry({
        path: 'big.txt',
        op: 'write',
        before: null,
        beforeHash: sha256Hex('gone\n'),
        after: big,
        bytesDelta: 0,
        unattributed: true,
      }),
    );
    expect(recorded.deltaBaseEmpty).toBe(true);
    // A torn blob at the hash-only beforeHash must not be read at all when
    // reconstruction uses '' — reading it wastes I/O and fires onCorrupt
    // for content that never affected the result.
    writeFileSync(join(dir, 'blobs', recorded.beforeHash ?? ''), 'torn\n');
    const details: string[] = [];
    expect(store.readAfter(recorded, (detail) => details.push(detail))).toBe(
      big,
    );
    expect(details).toEqual([]);
  });

  it('a tool-authored delta entry with a missing before-blob refuses to reconstruct', () => {
    // Reconstructing from '' here silently fabricates after-content that
    // never existed on disk — refuse instead.
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const before = 'b\n'.repeat(40_000);
    const after = 'c\n'.repeat(40_000);
    const recorded = store.append(
      entry({ path: 'big.txt', before, after, bytesDelta: 0 }),
    );
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.deltaBaseEmpty).toBe(undefined);
    rmSync(join(dir, 'blobs', recorded.beforeHash ?? ''));
    expect(store.readAfter(recorded)).toBe(null);
  });
});

// Blob integrity: blobs are content-addressed, so a blob whose
// content does not hash to its name must read as missing — never as truth.
describe('blob hash verification', () => {
  it('a blob whose content does not hash to its name reads as missing', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(entry({ path: 'a.txt', after: 'hello\n' }));
    writeFileSync(join(dir, 'blobs', recorded.afterHash ?? ''), 'tampered\n');
    expect(store.readAfter(recorded)).toBe(null);
  });

  it('corrupt blobs are reported through the onCorrupt hook', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(
      entry({ path: 'a.txt', before: 'v1\n', after: 'v2\n', bytesDelta: 0 }),
    );
    writeFileSync(join(dir, 'blobs', recorded.beforeHash ?? ''), 'tampered\n');
    const details: string[] = [];
    expect(store.readBefore(recorded, (detail) => details.push(detail))).toBe(
      null,
    );
    expect(details.join('\n')).toContain(recorded.beforeHash ?? 'missing');
  });

  it('a delta reconstruction that fails the recorded after-hash reads as corrupt, never as content', () => {
    // Defense in depth: if a base is ever mis-guessed again,
    // the reconstruction will not hash to entry.afterHash — fail closed to
    // null with a named report instead of serving wrong after-content.
    const dir = tmpRoot();
    const after = 'real\nafter\n';
    const foreign = 'foreign\nbase\n';
    // The delta is encoded against '' but the entry claims a before-blob
    // base — the exact shape of the shared-blob mis-guess.
    const delta = encodeDelta('', after);
    const deltaHash = sha256Hex(delta);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'blobs', deltaHash), delta);
    writeFileSync(join(dir, 'blobs', sha256Hex(foreign)), foreign);
    const forged: JournalEntry = {
      source: 'tool',
      path: 'forged.txt',
      op: 'write',
      beforeHash: sha256Hex(foreign),
      afterHash: sha256Hex(after),
      deltaHash,
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 1,
    };
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(forged)}\n`);
    const store = new FileJournalStore(dir);
    const details: string[] = [];
    expect(store.readAfter(forged, (detail) => details.push(detail))).toBe(
      null,
    );
    expect(details.join('\n')).toContain(forged.afterHash);
  });

  it('undo never restores content from a hash-corrupt before-blob', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(
      entry({ path: 'f.txt', before: 'v1\n', after: 'v2\n', bytesDelta: 0 }),
    );
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'f.txt'), 'v2\n');
    writeFileSync(join(dir, 'blobs', recorded.beforeHash ?? ''), 'evil\n');
    const result = restoreEntry(store, recorded, root);
    expect(result.restored).toBe(false);
    // Wrong content must never be written over the real file.
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2\n');
  });
});

describe('sweep bytesDelta', () => {
  it('is nonzero for a sweep entry that changed size', () => {
    const root = tmpRoot('journal-delta-');
    writeFileSync(join(root, 'grown.ts'), 'before\n');
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'grown.ts'), 'before, and much more\n');
    const store = new FileJournalStore(tmpRoot('j-delta-'));
    // Scripted object store answering the boot blob (the file was clean at
    // baseline): the sweep stores the pre-image and sizes the delta.
    const before = Buffer.from('before\n', 'utf8');
    const gitRun: GitCommand = (args: string[]) =>
      args[0] === 'cat-file' && args[1] === '-s'
        ? { status: 0, stdout: Buffer.from(`${before.length}\n`, 'utf8') }
        : { status: 0, stdout: before };
    const added = reconcile(
      store,
      baseline,
      root,
      {
        sessionId: 's1',
        timestamp: 1,
      },
      { gitBaseline: { 'grown.ts': 'a'.repeat(40) }, gitRun },
    );
    expect(added).toBe(1);
    const swept = store.entries()[0];
    if (swept === undefined) throw new Error('missing sweep entry');
    expect(swept.bytesDelta).toBe(
      Buffer.byteLength('before, and much more\n', 'utf8') -
        Buffer.byteLength('before\n', 'utf8'),
    );
    expect(swept.bytesDelta).not.toBe(0);
  });
});
