// Journal durability: the journal is the product's
// reversibility promise, so its own writes are the least forgiving place to
// cut corners.
//
//   - Index appends fsync before `append()` returns: a crash/power loss cannot
//     truncate the last index line in the window the journal
//     itself declared safe. The bridge grows an opt-in `appendDurably`;
//     production takes it, test doubles without it keep the old seam.
//   - Blob writes are tmp+rename: content-addressed blobs are never exposed
//     half-written under their real name (readBlob would serve the torn bytes
//     as content hash check rejects them).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  type JournalEntryInput,
  sha256Hex,
} from './journal.js';

// Controllable failure/hook surface shared by the two module mocks below.
// vi.hoisted keeps it reachable from the hoisted factories.
const hooks = vi.hoisted(() => ({
  fsyncs: 0,
  durableAppends: [] as string[],
  // Force renameFile to throw for matching destinations (crash-before-rename).
  failRename: null as null | ((destination: string) => boolean),
  // Force writeFile to land a torn prefix and throw (crash-mid-write).
  tornWrite: null as null | ((path: string) => boolean),
  // Simulate a bridge double that predates appendDurably.
  withoutAppendDurably: false,
}));

// Count every fsync through the real node bridge: the durability claim is
// only proven if the production implementation actually calls it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      hooks.fsyncs += 1;
      actual.fsyncSync(fd);
    },
  };
});

vi.mock('./file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        appendDurably: hooks.withoutAppendDurably
          ? undefined
          : (path: string, content: string | Uint8Array): void => {
              hooks.durableAppends.push(path);
              bridge.appendDurably?.(path, content);
            },
        renameFile: (source: string, destination: string): void => {
          if (hooks.failRename?.(destination) === true) {
            throw new Error('simulated crash before rename');
          }
          bridge.renameFile(source, destination);
        },
        writeFile: (path: string, content: string | Uint8Array): void => {
          if (hooks.tornWrite?.(path) === true) {
            // A real torn write leaves a prefix on disk, then the process
            // (or the syscall) dies.
            bridge.writeFile(path, String(content).slice(0, 4));
            throw new Error('simulated crash mid-write');
          }
          bridge.writeFile(path, content);
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
  const root = mkdtempSync(join(tmpdir(), 'journal-durable-'));
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

describe('journal durability', () => {
  it('fsyncs the index on every append, through the durable bridge seam', () => {
    const store = new FileJournalStore(tmpRoot());
    hooks.fsyncs = 0;
    hooks.durableAppends = [];
    store.append(entry({ path: 'a.txt', after: 'hello\n' }));
    // The blob the entry references is flushed too: one flush
    // for the blob's bytes, one for its directory entry, then the index
    // line — the record is always last.
    expect(hooks.fsyncs).toBe(3);
    store.append(entry({ path: 'b.txt', after: 'world\n' }));
    expect(hooks.fsyncs).toBe(6);
    // The durable path is the bridge method, never plain appendFile.
    expect(
      hooks.durableAppends.filter((path) => path.endsWith('index.jsonl')),
    ).toHaveLength(2);
    expect(store.entries()).toHaveLength(2);
  });

  it('durable: false keeps the plain append seam and fsyncs nothing', () => {
    const store = new FileJournalStore(tmpRoot(), { durable: false });
    hooks.fsyncs = 0;
    store.append(entry({ path: 'a.txt', after: 'hello\n' }));
    expect(hooks.fsyncs).toBe(0);
    // The line still lands — the knob trades the fsync, not the append.
    expect(store.entries()).toHaveLength(1);
  });

  it('a bridge double without appendDurably keeps appending (old seam)', () => {
    hooks.withoutAppendDurably = true;
    try {
      const store = new FileJournalStore(tmpRoot());
      hooks.fsyncs = 0;
      hooks.durableAppends = [];
      store.append(entry({ path: 'a.txt', after: 'hello\n' }));
      expect(store.entries()).toHaveLength(1);
      // The index line falls back to the plain append (no fsync), but the
      // blob it references is still flushed: two fsyncs, none
      // of them the index.
      expect(hooks.fsyncs).toBe(2);
      expect(
        hooks.durableAppends.filter((path) => path.endsWith('index.jsonl')),
      ).toEqual([]);
    } finally {
      hooks.withoutAppendDurably = false;
    }
  });

  it('never exposes a partial blob: a failed rename leaves no blob and no tmp litter', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    hooks.failRename = (destination) =>
      destination.includes(`${'/'}blobs${'/'}`);
    try {
      expect(() =>
        store.append(entry({ path: 'a.txt', after: 'hello\n' })),
      ).toThrow();
    } finally {
      hooks.failRename = null;
    }
    // No partial blob under the real name, and the tmp is cleaned up.
    expect(readdirSync(join(dir, 'blobs'))).toEqual([]);
    expect(store.blobCount()).toBe(0);
    // And no entry references a blob that was never written: a failed blob
    // write fails the append (a silent entry would read as corrupt).
    expect(store.entries()).toEqual([]);
  });

  it('a torn blob write fails the append and leaves no torn prefix behind', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    hooks.tornWrite = (path) =>
      path.includes(`${'/'}blobs${'/'}`) && path.endsWith('.tmp');
    try {
      expect(() =>
        store.append(entry({ path: 'a.txt', after: 'hello world\n' })),
      ).toThrow(/simulated crash mid-write/);
    } finally {
      hooks.tornWrite = null;
    }
    // The torn prefix landed only in the tmp, which is cleaned up; nothing
    // is visible under the content address and no entry references it.
    expect(readdirSync(join(dir, 'blobs'))).toEqual([]);
    expect(store.entries()).toEqual([]);
  });

  it('blob content is intact through the rename when the write succeeds', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(entry({ path: 'a.txt', after: 'hello\n' }));
    const blob = join(dir, 'blobs', recorded.afterHash ?? 'missing');
    expect(readFileSync(blob, 'utf8')).toBe('hello\n');
    expect(sha256Hex(readFileSync(blob, 'utf8'))).toBe(recorded.afterHash);
    // No tmp survives a successful putBlob: the blob is the only file.
    expect(readdirSync(join(dir, 'blobs'))).toEqual([recorded.afterHash]);
  });
});
