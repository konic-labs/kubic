// Slice A: content-addressed journal store (issue #17; §42.4).
// RED: FileJournalStore does not exist yet.
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  encodeDelta,
  FileJournalStore,
  type JournalEntryInput,
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
