// Journal cross-process coordination.
//
// pi-durable owns a storage exclusively and does no cross-process locking;
// the journal had no guard at all either, so two processes could interleave.
// A line appended between a reader's `entries()` and its rename was silently
// dropped by the rename; the blob sweep deleted the `${hash}.${pid}.tmp` a
// live run was about to rename into place; and a read-time retention pass ran
// under a live session. Mutations now run under an O_EXCL lock beside the
// index, the rewrite abandons itself when the index changed under it, and the
// sweep only removes blobs that are unambiguously dead.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  type JournalEntryInput,
  journalMutationLockPath,
  sha256Hex,
} from './journal.js';

const hooks = vi.hoisted(() => ({
  // Called with the path about to be written; the hook may act on the world
  // (simulate another process) before the real write happens.
  onWrite: null as null | ((path: string) => void),
  onAppendDurably: null as null | ((path: string) => void),
  // Called after a read completes (the reader has its content; the world may
  // change before the caller samples anything else).
  onReadText: null as null | ((path: string) => void),
}));

vi.mock('./file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        writeFile: (path, content, options) => {
          hooks.onWrite?.(path);
          bridge.writeFile(path, content, options);
        },
        appendDurably: (path, content) => {
          hooks.onAppendDurably?.(path);
          bridge.appendDurably?.(path, content);
        },
        readTextFile: (path) => {
          const content = bridge.readTextFile(path);
          hooks.onReadText?.(path);
          return content;
        },
      };
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  hooks.onWrite = null;
  hooks.onAppendDurably = null;
  hooks.onReadText = null;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-lock-'));
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
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('journal mutation lock', () => {
  it('holds the mutation lock while it appends, and releases it after', () => {
    const dir = tmpRoot();
    // Durable on purpose: the index append goes through `appendDurably`,
    // which is where the hook can look at the lock mid-mutation.
    const store = new FileJournalStore(dir);
    const lock = journalMutationLockPath(join(dir, 'index.jsonl'));
    let heldDuringAppend = false;
    hooks.onAppendDurably = (path) => {
      if (path.endsWith('index.jsonl')) heldDuringAppend = existsSync(lock);
    };
    store.append(entry({ path: 'a.txt' }));
    expect(heldDuringAppend).toBe(true);
    // Released: the next writer (or a reader's skip check) sees no holder.
    expect(existsSync(lock)).toBe(false);
  });

  it('steals a stale lock instead of wedging on it', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    const lock = journalMutationLockPath(join(dir, 'index.jsonl'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, '999999');
    // A crashed holder's residue: older than the stale window.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    store.append(entry({ path: 'a.txt' }));
    expect(store.entries().map((e) => e.path)).toEqual(['a.txt']);
    expect(existsSync(lock)).toBe(false);
  });

  it('keeps a line appended between the retention read and its rename', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const indexPath = join(dir, 'index.jsonl');
    const tmp = `${indexPath}.${process.pid}.tmp`;
    // The interleave: another writer (one that does not hold the lock — an
    // older build, a hand edit) appends while this pass is rewriting.
    hooks.onWrite = (path) => {
      if (path !== tmp) return;
      hooks.onWrite = null;
      appendFileSync(
        indexPath,
        `${JSON.stringify({
          path: 'interleaved.txt',
          op: 'write',
          beforeHash: null,
          afterHash: sha256Hex('i\n'),
          deltaHash: null,
          bytesDelta: 2,
          sessionId: 'other',
          agentId: 'other',
          toolCallId: null,
          timestamp: 1_700_000_001_000,
        })}\n`,
      );
    };
    const pruned = store.enforceRetention({ maxBytes: 1 });
    // The rewrite noticed the index had moved and abandoned itself: the
    // interleaved line survives, and the pass reports that it dropped
    // nothing rather than pretending it pruned.
    expect(pruned.entries).toBe(0);
    expect(store.entries().map((e) => e.path)).toEqual([
      'a.txt',
      'b.txt',
      'interleaved.txt',
    ]);
    // No tmp litter from the abandoned rewrite.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
    // The abandon dropped the caches, so the next pass cannot
    // prove the bound from a stale under-count — it re-reads the index.
    let indexReads = 0;
    hooks.onReadText = (path) => {
      if (path === indexPath) indexReads += 1;
    };
    const next = store.enforceRetention({ maxBytes: 1024 * 1024 });
    expect(next.entries).toBe(0);
    expect(indexReads).toBeGreaterThan(0);
  });

  it('keeps a line appended while the retention pass is reading the index', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const indexPath = join(dir, 'index.jsonl');
    // The size must be sampled BEFORE the read, so an append
    // that lands inside the read window cannot hide inside the sample. The
    // hook fires after the reader has its content: `all` does not contain the
    // line, and only a sample taken earlier can notice it.
    hooks.onReadText = (path) => {
      if (path !== indexPath) return;
      hooks.onReadText = null;
      appendFileSync(
        indexPath,
        `${JSON.stringify({
          path: 'mid-read.txt',
          op: 'write',
          beforeHash: null,
          afterHash: sha256Hex('m\n'),
          deltaHash: null,
          bytesDelta: 2,
          sessionId: 'other',
          agentId: 'other',
          toolCallId: null,
          timestamp: 1_700_000_002_000,
        })}\n`,
      );
    };
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBe(0);
    expect(store.entries().map((e) => e.path)).toContain('mid-read.txt');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('never removes a blob that appeared after the pass started', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const blobs = join(dir, 'blobs');
    // A blob a non-cooperating writer just dropped in: newer than the pass
    // that is about to sweep. Left alone — an orphan is a leak, not damage.
    const fresh = join(blobs, sha256Hex('fresh\n'));
    writeFileSync(fresh, 'fresh\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(fresh, future, future);
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBeGreaterThan(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('sweeps an orphan written earlier in the millisecond the pass started', () => {
    // `Date.now()` is whole milliseconds and a blob's `mtimeMs` is not: an
    // orphan written in the pass's own millisecond read as newer than the
    // pass and survived it (a flake on a fast CI runner).
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const blobs = join(dir, 'blobs');
    const passStart = Date.now();
    const within = (passStart + 0.5) / 1000;
    utimesSync(join(blobs, sha256Hex('a\n')), within, within);
    vi.useFakeTimers({ toFake: ['Date'], now: passStart });
    try {
      store.enforceRetention({ maxBytes: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(readdirSync(blobs)).toEqual([sha256Hex('b\n')]);
  });

  it('never removes an in-flight `*.pid.tmp` blob', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const blobs = join(dir, 'blobs');
    // Another process's blob, written but not yet renamed into place.
    const inFlight = join(blobs, `${sha256Hex('pending\n')}.4242.tmp`);
    writeFileSync(inFlight, 'pending\n');
    // An OLD tmp: only the name guard can save it, not the freshness one.
    const old = new Date(Date.now() - 60_000);
    utimesSync(inFlight, old, old);
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBeGreaterThan(0);
    // The orphaned real blob is swept; the in-flight tmp is not touched.
    expect(existsSync(inFlight)).toBe(true);
    expect(readdirSync(blobs).sort()).toEqual([
      `${sha256Hex('b\n')}`,
      `${sha256Hex('pending\n')}.4242.tmp`,
    ]);
  });
});
