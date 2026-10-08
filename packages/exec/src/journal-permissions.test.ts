// Private journal state.
//
// A journal blob is a copy of file content — including 0600 sources like
// `.env` — and the index holds every path and hash of the run. Written with
// umask defaults they were 0644 in a 0755 directory, so any local user could
// read every snapshot on a shared machine. Kubic now creates its own state
// private: 0700 directories, 0600 files, and an existing loose directory is
// tightened on the way in.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileJournalStore, type JournalEntryInput } from './journal.js';

const roots: string[] = [];
let priorUmask = 0o022;

// The modes are asserted exactly, so the ambient umask must not decide the
// outcome: under umask 077 code that set no mode would also produce 0700/0600
// and pass. Pinned to the common 022 and restored per test.
beforeEach(() => {
  priorUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(priorUmask);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-perm-'));
  roots.push(root);
  return root;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
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

describe('journal state permissions', () => {
  it('creates the journal directory 0700 and its blobs and index 0600', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ before: 'v1\n', after: 'v2\n' }));
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, 'blobs'))).toBe(0o700);
    expect(modeOf(join(dir, 'index.jsonl'))).toBe(0o600);
    const blobs = readdirSync(join(dir, 'blobs'));
    expect(blobs.length).toBeGreaterThan(0);
    for (const name of blobs) {
      expect(modeOf(join(dir, 'blobs', name))).toBe(0o600);
    }
  });

  it('creates the index 0600 through the durable append seam too', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir); // durable on
    store.append(entry({ path: 'a.txt' }));
    expect(modeOf(join(dir, 'index.jsonl'))).toBe(0o600);
  });

  it('tightens an existing loose journal directory on the next mutation', () => {
    const dir = tmpRoot();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(modeOf(dir)).toBe(0o755);
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt' }));
    expect(modeOf(dir)).toBe(0o700);
  });

  it('keeps the retention rewrite private', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'a.txt', after: 'a\n' }));
    store.append(entry({ path: 'b.txt', after: 'b\n' }));
    const pruned = store.enforceRetention({ maxBytes: 1 });
    expect(pruned.entries).toBeGreaterThan(0);
    expect(modeOf(join(dir, 'index.jsonl'))).toBe(0o600);
    for (const name of readdirSync(join(dir, 'blobs'))) {
      expect(modeOf(join(dir, 'blobs', name))).toBe(0o600);
    }
  });
});
