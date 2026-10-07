// Journal durable writes: the index line is fsynced, so the
// blobs it references must be on platter BEFORE it — otherwise a power loss
// leaves a durable entry pointing at a zero-length or missing blob, undo
// reports "no before-content", and the corrupt file is never healed because
// putBlob trusts the name. The retention rewrite has the mirror problem: a
// crash right after its rename can replace the journal's whole history with
// an empty file, because nothing was flushed before the rename.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  type JournalEntryInput,
  sha256Hex,
} from './journal.js';

// Every I/O seam the durable path is supposed to use, in order, plus a count
// of the real fsyncs that reached the filesystem.
const log = vi.hoisted(() => ({ calls: [] as string[], fsyncs: 0 }));

// A filesystem that refuses a flush (EINVAL/EOPNOTSUPP on FUSE or overlay
// mounts, EPERM/EISDIR on a Windows directory handle) versus one that fails
// a flush for real (EIO/ENOSPC). The journal must tell them apart.
const hooks = vi.hoisted(() => ({
  refuseFlush: null as null | ((path: string) => boolean),
  failFlush: null as null | ((path: string) => boolean),
}));

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// Count fsyncs through the real node bridge: the durability claim is only
// proven if the production implementation actually flushes.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      log.fsyncs += 1;
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
      const record = <T>(label: string, run: () => T): T => {
        log.calls.push(label);
        return run();
      };
      return {
        ...bridge,
        readTextFile: (path: string) =>
          record(`read:${path}`, () => bridge.readTextFile(path)),
        writeFile: (path, content, options) =>
          record(`write:${path}`, () =>
            bridge.writeFile(path, content, options),
          ),
        renameFile: (source, destination) =>
          record(`rename:${source}->${destination}`, () =>
            bridge.renameFile(source, destination),
          ),
        appendDurably: (path, content) =>
          record(`appendDurably:${path}`, () =>
            bridge.appendDurably?.(path, content),
          ),
        flushFile: (path) =>
          record(`flushFile:${path}`, () => {
            if (hooks.failFlush?.(path) === true) {
              throw errno('EIO', 'simulated flush failure');
            }
            if (hooks.refuseFlush?.(path) === true) {
              throw errno('EOPNOTSUPP', 'simulated unsupported flush');
            }
            bridge.flushFile?.(path);
          }),
        flushDir: (path) =>
          record(`flushDir:${path}`, () => {
            if (hooks.failFlush?.(path) === true) {
              throw errno('EIO', 'simulated flush failure');
            }
            if (hooks.refuseFlush?.(path) === true) {
              throw errno('EOPNOTSUPP', 'simulated unsupported flush');
            }
            bridge.flushDir?.(path);
          }),
      };
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  log.calls = [];
  log.fsyncs = 0;
  hooks.refuseFlush = null;
  hooks.failFlush = null;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-durable-writes-'));
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

// A pre-existing blob file at `hash`, as crash residue or an external
// write leaves it.
function seedBlob(dir: string, hash: string, content: string): string {
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'blobs', hash), content);
  return hash;
}

describe('journal durable writes', () => {
  it('fsyncs a blob and its directory before the index line is appended', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append(entry({ before: 'v1\n', after: 'v2\n' }));
    const index = join(dir, 'index.jsonl');
    const blobFlush = log.calls.findIndex(
      (call) =>
        call.startsWith('flushFile:') && call.includes(`${sep}blobs${sep}`),
    );
    const blobDirFlush = log.calls.indexOf(`flushDir:${join(dir, 'blobs')}`);
    const indexAppend = log.calls.indexOf(`appendDurably:${index}`);
    expect(blobFlush).toBeGreaterThanOrEqual(0);
    expect(blobDirFlush).toBeGreaterThanOrEqual(0);
    // The entry is only recorded after the content it references is
    // durable: the append is the LAST of the three.
    expect(indexAppend).toBeGreaterThan(blobFlush);
    expect(indexAppend).toBeGreaterThan(blobDirFlush);
    // Real fsyncs, not just bridge calls: two blobs (before + after), each
    // with its directory entry, then the index line.
    expect(log.fsyncs).toBe(5);
    expect(store.readBefore(recorded)).toBe('v1\n');
    expect(store.readAfter(recorded)).toBe('v2\n');
  });

  it('durable: false keeps the plain write and fsyncs nothing', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ before: 'v1\n', after: 'v2\n' }));
    expect(log.calls.filter((call) => call.startsWith('flush'))).toEqual([]);
    expect(log.fsyncs).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  it('rewrites a truncated blob found at the target hash', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const before = 'the real pre-image\n';
    // Crash residue on a delayed-allocation filesystem: the rename landed,
    // the data did not — so the target address holds a zero-length file.
    const hash = seedBlob(dir, sha256Hex(before), '');
    const recorded = store.append(entry({ before, after: 'x\n' }));
    expect(recorded.beforeHash).toBe(hash);
    expect(readFileSync(join(dir, 'blobs', hash), 'utf8')).toBe(before);
    expect(store.readBefore(recorded)).toBe(before);
  });

  it('rewrites a same-size blob whose bytes do not hash to its name', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const before = 'the real pre-image\n';
    // Same length, so the size gate cannot catch it: the hash must.
    const hash = seedBlob(dir, sha256Hex(before), 'X'.repeat(before.length));
    const recorded = store.append(entry({ before, after: 'x\n' }));
    expect(readFileSync(join(dir, 'blobs', hash), 'utf8')).toBe(before);
    expect(store.readBefore(recorded)).toBe(before);
  });

  it('leaves an intact blob alone: no rewrite, no tmp', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const before = 'shared pre-image\n';
    const hash = seedBlob(dir, sha256Hex(before), before);
    log.calls = [];
    const recorded = store.append(entry({ before, after: 'x\n' }));
    expect(
      log.calls.filter(
        (call) => call.includes(hash) && !call.startsWith('read:'),
      ),
    ).toEqual([]);
    expect(store.readBefore(recorded)).toBe(before);
  });

  it('flushes the retention rewrite before renaming it over the index', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const index = join(dir, 'index.jsonl');
    const tmp = `${index}.${process.pid}.tmp`;
    log.calls = [];
    log.fsyncs = 0;
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBeGreaterThan(0);
    // The whole history is replaced by one rename: its bytes are flushed
    // first, and the rename is flushed after, so a crash cannot leave an
    // empty or truncated index where the old one was. (Index reads are the
    // pass's own, not part of the rewrite.)
    expect(log.calls.filter((call) => !call.startsWith('read:'))).toEqual([
      `write:${tmp}`,
      `flushFile:${tmp}`,
      `rename:${tmp}->${index}`,
      `flushDir:${dir}`,
    ]);
    expect(log.fsyncs).toBe(2);
  });

  it('durable: false leaves the retention rewrite unfsynced', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    log.calls = [];
    log.fsyncs = 0;
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBe(1);
    expect(log.calls.filter((call) => call.startsWith('flush'))).toEqual([]);
    expect(log.fsyncs).toBe(0);
  });
});

// Review finding 2: a refused flush is not a failed write.
describe('journal durable writes: refused flushes', () => {
  it('records the append when the filesystem refuses a directory flush', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    hooks.refuseFlush = (path) => path === join(dir, 'blobs');
    const recorded = store.append(entry({ path: 'a.txt', after: 'hello\n' }));
    // Rename atomicity still holds, so the write is recorded rather than
    // blocked on a platform that cannot flush a directory.
    expect(store.entries()).toHaveLength(1);
    expect(store.readAfter(recorded)).toBe('hello\n');
  });

  it('still completes a compaction whose directory flush is refused', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    hooks.refuseFlush = (path) => path === dir;
    const pruned = store.enforceRetention({ maxBytes: 1 });
    // The rename landed and the pass reports it: a refused flush must not
    // turn a compaction into a silent {0, 0} no-op either. (The drop set is
    // the retention rule's business, not this test's.)
    expect(pruned.entries).toBeGreaterThan(0);
    expect(pruned.entries + store.entries().length).toBe(2);
  });

  it('still fails the append when a flush fails for real', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    hooks.failFlush = (path) => path.includes(`${sep}blobs${sep}`);
    expect(() =>
      store.append(entry({ path: 'a.txt', after: 'hello\n' })),
    ).toThrow(/simulated flush failure/);
    // No entry without its content: the journal never promises durability
    // it could not deliver.
    expect(store.entries()).toEqual([]);
  });
});

// Review finding 3: healing crash residue must not cost a full
// read + hash of every reused blob.
describe('journal durable writes: blob reuse', () => {
  it('trusts a blob it wrote itself, with no re-read on reuse', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const content = 'reused content\n';
    const first = store.append(entry({ path: 'a.txt', after: content }));
    const blob = join(dir, 'blobs', first.afterHash ?? 'missing');
    log.calls = [];
    const second = store.append(entry({ path: 'b.txt', after: content }));
    expect(log.calls.filter((call) => call === `read:${blob}`)).toEqual([]);
    expect(second.afterHash).toBe(first.afterHash);
    expect(store.readAfter(second)).toBe(content);
  });

  it('reads and hashes a blob it did not write', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const content = 'foreign content\n';
    const hash = seedBlob(dir, sha256Hex(content), content);
    log.calls = [];
    const recorded = store.append(entry({ path: 'a.txt', after: content }));
    // Not written by this store: it is verified before it is reused.
    expect(log.calls).toContain(`read:${join(dir, 'blobs', hash)}`);
    expect(store.readAfter(recorded)).toBe(content);
  });
});
