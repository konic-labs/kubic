// Slice A: content-addressed journal store (issue #17; §42.4).
// RED: FileJournalStore does not exist yet.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  encodeDelta,
  FileJournalStore,
  type JournalEntryInput,
  restoreEntry,
} from './journal.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'journal-'));
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

describe('journal store (issue #17, slice A)', () => {
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
    expect(store.entries()).toHaveLength(2);
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
    const recorded = store.append(
      entry({
        path: 'big.txt',
        before,
        after: 'changed\n',
        bytesDelta: -99990,
      }),
    );
    expect(store.readBefore(recorded)).toBe(before);
  });

  it('applyDelta returns null on malformed delta JSON instead of throwing', () => {
    // Hash-valid but malformed deltas must never crash a caller
    // (issue #111): torn content that happens to parse-check fails
    // closed to null, and callers treat it as missing.
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
    expect(store.entries()[0]?.path).toBe('new.txt');
    expect(store.blobCount()).toBe(1);

    const small = store.enforceRetention({ maxBytes: 1, now: 2000 });
    expect(small.entries).toBe(1);
    expect(store.entries()).toEqual([]);
    expect(store.blobCount()).toBe(0);
  });
});

// Blob integrity (issue #111): the delta base is recorded, never guessed.
describe('deltaBaseEmpty schema (issue #111)', () => {
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

// Blob integrity (issue #111): blobs are content-addressed, so a blob whose
// content does not hash to its name must read as missing — never as truth.
describe('blob hash verification (issue #111)', () => {
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
    expect(
      store.readBefore(recorded, (detail) => details.push(detail)),
    ).toBe(null);
    expect(details.join('\n')).toContain(recorded.beforeHash ?? 'missing');
  });

  it('undo never restores content from a hash-corrupt before-blob', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(
      entry({ path: 'f.txt', before: 'v1\n', after: 'v2\n', bytesDelta: 0 }),
    );
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'f.txt'), 'v2\n');
    writeFileSync(join(dir, 'blobs', recorded.beforeHash ?? ''), 'evil\n');
    const result = restoreEntry(store, recorded, root);
    expect(result.restored).toBe(false);
    // Wrong content must never be written over the real file.
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2\n');
  });
});
