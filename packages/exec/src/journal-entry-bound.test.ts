// Journal entry bound (issue #348; §42.4 "retention is bounded by size").
//
// enforceRetention dropped oldest-first until the referenced bytes fit the
// bound — including the newest entry, and therefore the entry `append` had
// just written. One edit to a file larger than the whole journal bound wiped
// the session's history, and `append` still returned normally: the file
// changed, nothing recorded it, and undo had nothing to restore. The other
// half of the hole is an entry whose own content cannot fit any journal: it
// must be refused up front, with the target file untouched, instead of
// landing a record that the same append's retention pass then deletes.
//
// RED: the drop loop is `kept.length > 0` and `append` never checks the
// entry's own size.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileJournalStore,
  type JournalEntry,
  type JournalEntryInput,
  JournalEntryTooLargeError,
} from './journal.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-bound-'));
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
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe('journal entry bound (issue #348)', () => {
  it('refuses an entry whose own blobs exceed the bound, writing nothing', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { maxBytes: 1000 });
    store.append(entry({ path: 'small.txt', after: 'ok\n' }));
    const before = 'x'.repeat(2000);
    expect(() =>
      store.append(entry({ path: 'big.txt', before, after: 'y\n' })),
    ).toThrow(JournalEntryTooLargeError);
    // The error names the bound (the model and the operator both need the
    // number, not just "too large").
    expect(() =>
      store.append(entry({ path: 'big.txt', before, after: 'y\n' })),
    ).toThrow(/1000/);
    // Earlier entries remain, the refused entry left nothing behind, and
    // its blob was never written.
    expect(store.entries().map((e) => e.path)).toEqual(['small.txt']);
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(1);
  });

  it('reports the bound on the error itself', () => {
    const store = new FileJournalStore(tmpRoot(), { maxBytes: 1000 });
    try {
      store.append(entry({ before: 'x'.repeat(2000), after: null }));
      throw new Error('expected the append to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(JournalEntryTooLargeError);
      const tooLarge = error as JournalEntryTooLargeError;
      expect(tooLarge.name).toBe('JournalEntryTooLargeError');
      expect(tooLarge.maxBytes).toBe(1000);
      expect(tooLarge.entryBytes).toBe(2000);
    }
  });

  it('accepts an entry that fits exactly, including the delta shape', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { maxBytes: 1000 });
    const exact = 'x'.repeat(1000);
    // At the bound is not over it.
    const recorded = store.append(entry({ path: 'exact.txt', after: exact }));
    expect(store.readAfter(recorded)).toBe(exact);
  });

  it('keeps the newest entry and reports how far over the bound it is', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { maxBytes: 10_000 });
    store.append(entry({ path: 'a.txt', after: `${'a'.repeat(50)}\n` }));
    store.append(entry({ path: 'b.txt', after: `${'b'.repeat(50)}\n` }));
    const pruned = store.enforceRetention({ maxBytes: 10 });
    // The newest entry is never dropped, even when it alone is over the
    // bound: losing the record of the change just made is the one thing a
    // change journal may not do.
    const kept = store.entries();
    expect(kept.map((e) => e.path)).toEqual(['b.txt']);
    expect(pruned.entries).toBe(1);
    // The bound is the whole store (issue #350): the kept line plus its blob
    // bytes, against a 10-byte bound.
    const keptEntry = kept[0] as JournalEntry;
    const keptBytes =
      Buffer.byteLength(`${JSON.stringify(keptEntry)}\n`, 'utf8') +
      Buffer.byteLength(`${'b'.repeat(50)}\n`, 'utf8');
    expect(pruned.overBound).toBe(keptBytes - 10);
  });

  it('an overflowing sequence always keeps the newest entry', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { maxBytes: 100 });
    for (const name of ['a', 'b', 'c', 'd']) {
      store.append(
        entry({ path: `${name}.txt`, after: `${'y'.repeat(60)}\n` }),
      );
      expect(store.entries().at(-1)?.path).toBe(`${name}.txt`);
    }
    const entries = store.entries();
    expect(entries.at(-1)?.path).toBe('d.txt');
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('reports no over-bound bytes when the kept set fits', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { maxBytes: 10_000 });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const pruned = store.enforceRetention({ maxBytes: 10_000 });
    expect(pruned).toEqual({ entries: 0, bytes: 0, overBound: 0 });
  });
});
