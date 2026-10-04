// Journal durable writes (issue #344): the index line is fsynced, so the
// blobs it references must be on platter BEFORE it — otherwise a power loss
// leaves a durable entry pointing at a zero-length or missing blob, undo
// reports "no before-content", and the corrupt file is never healed because
// putBlob trusts the name. The retention rewrite has the mirror problem: a
// crash right after its rename can replace the journal's whole history with
// an empty file, because nothing was flushed before the rename.
//
// RED: putBlob is tmp+rename with no fsync and an exists() short-circuit,
// and enforceRetention rewrites with writeFile+rename and no fsync.
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
          record(`flushFile:${path}`, () => bridge.flushFile?.(path)),
        flushDir: (path) =>
          record(`flushDir:${path}`, () => bridge.flushDir?.(path)),
      };
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  log.calls = [];
  log.fsyncs = 0;
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

describe('journal durable writes (issue #344)', () => {
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
    expect(log.calls.filter((call) => call.includes(hash))).toEqual([]);
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
    expect(pruned.entries).toBe(2);
    // The whole history is replaced by one rename: its bytes are flushed
    // first, and the rename is flushed after, so a crash cannot leave an
    // empty or truncated index where the old one was.
    expect(log.calls).toEqual([
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
    log.calls = [];
    log.fsyncs = 0;
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBe(1);
    expect(log.calls.filter((call) => call.startsWith('flush'))).toEqual([]);
    expect(log.fsyncs).toBe(0);
  });
});
