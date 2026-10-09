// Journal torn-tail repair.
//
// A crash mid-append — or ENOSPC, EIO — leaves the index without its
// trailing newline. Appending blind glues the next entry onto that fragment,
// JSON.parse fails on the merged line, and `entries()` drops BOTH: the write
// happened, the record is unreadable, and undo/diff never see it. The append
// now repairs the tail first (one pread of the last byte), and a failed
// append truncates the partial write back so the repair is never half-done.
import {
  appendFileSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { FileBridge } from '../file-bridge.js';
import { FileJournalStore } from './store.js';
import type { JournalEntryInput } from './types.js';

// Controllable failure surface shared by the module mock below (vi.hoisted
// keeps it reachable from the hoisted factory). `failAppend` is a predicate
// over the appended path, and it fires once.
const hooks = vi.hoisted(() => ({
  failAppend: null as null | ((path: string) => boolean),
  failFileInfo: null as null | ((path: string) => boolean),
  failReadRange: null as null | ((path: string) => boolean),
  withoutReadFileRange: false,
}));

// Wrap the real node bridge so the append seams can land a torn prefix and
// throw — the crash-mid-append shape `writeSync` produces on ENOSPC.
vi.mock('../file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      const torn = (path: string, content: string | Uint8Array): void => {
        if (hooks.failAppend?.(path) !== true) return;
        hooks.failAppend = null;
        // A real torn append leaves a prefix on disk before it dies.
        bridge.appendFile(path, String(content).slice(0, 8));
        throw new Error('simulated ENOSPC mid-append');
      };
      return {
        ...bridge,
        readFileRange: hooks.withoutReadFileRange
          ? undefined
          : (path: string, start: number, end: number): Uint8Array => {
              if (hooks.failReadRange?.(path) === true) {
                throw new Error('simulated torn read');
              }
              return (
                bridge.readFileRange?.(path, start, end) ?? new Uint8Array()
              );
            },
        fileInfo: (path: string) => {
          if (hooks.failFileInfo?.(path) === true) {
            throw new Error('simulated stat failure');
          }
          return bridge.fileInfo(path);
        },
        appendDurably: (path: string, content: string | Uint8Array): void => {
          torn(path, content);
          bridge.appendDurably?.(path, content);
        },
        appendFile: (path: string, content: string | Uint8Array): void => {
          torn(path, content);
          bridge.appendFile(path, content);
        },
      };
    },
  };
});

afterEach(() => {
  hooks.failAppend = null;
  hooks.failFileInfo = null;
  hooks.failReadRange = null;
  hooks.withoutReadFileRange = false;
});

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

describe('journal torn tail', () => {
  it('closes a trailing fragment on its own line so the next entry is readable', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    // Crash residue: a partial entry, no terminating newline.
    appendFileSync(indexPath, '{"path":"torn');
    store.append(entry({ path: 'second.txt' }));

    const raw = readFileSync(indexPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // The fragment is closed where it stood: the repair byte is a newline,
    // the fragment is never rewritten or joined to the new entry.
    expect(raw).toContain('{"path":"torn\n');
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('repairs the tail through the plain append seam too (durable: false)', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir, { durable: false });
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    appendFileSync(indexPath, '{"path":"torn');
    store.append(entry({ path: 'second.txt' }));
    expect(readFileSync(indexPath, 'utf8')).toContain('{"path":"torn\n');
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('leaves no blank line when the tail is already terminated', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    store.append(entry({ path: 'second.txt' }));
    // No repair byte: the index grows by exactly the new line.
    const raw = readFileSync(indexPath, 'utf8');
    expect(raw.startsWith(before)).toBe(true);
    expect(raw.slice(before.length).split('\n')).toHaveLength(2);
  });

  it('truncates a partially written append back to the pre-append length', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    const before = statSync(indexPath).size;
    hooks.failAppend = (path) => path === indexPath;
    expect(() => store.append(entry({ path: 'second.txt' }))).toThrow(/ENOSPC/);

    const raw = readFileSync(indexPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(before);
    expect(store.entries().map((e) => e.path)).toEqual(['first.txt']);
    // And the next append lands normally — the failed one left nothing.
    store.append(entry({ path: 'third.txt' }));
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'third.txt',
    ]);
  });

  it('never truncates a symlinked index through its link', () => {
    const dir = tempDir('journal-torn-');
    const outside = tempDir('journal-torn-');
    const target = join(outside, 'target.jsonl');
    writeFileSync(target, 'x'.repeat(500));
    symlinkSync(target, join(dir, 'index.jsonl'));
    const store = new FileJournalStore(dir);
    hooks.failAppend = (path) => path === join(dir, 'index.jsonl');
    expect(() => store.append(entry({ path: 'first.txt' }))).toThrow(/ENOSPC/);
    // The torn prefix landed on the link's target (the append follows the
    // link — that part is the append's own doing), but the target keeps its
    // 500 bytes: `fileInfo` is an lstat, so the link's "size" is the length
    // of the target STRING, and truncating to it would cut the target down
    // to a few dozen garbage bytes. Only a regular file yields a truncate
    // target, so the failed append leaves the length alone.
    const raw = readFileSync(target, 'utf8');
    expect(raw.startsWith('x'.repeat(500))).toBe(true);
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(500);
  });

  it('starts a fresh index at the first entry, with no repair byte', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    // Nothing to repair on an index that does not exist yet: the file
    // opens with the entry, not a blank line.
    const raw = readFileSync(join(dir, 'index.jsonl'), 'utf8');
    expect(raw.startsWith('{')).toBe(true);
  });

  it('repairs the tail when the index length cannot be read', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    hooks.failFileInfo = (path) => path === indexPath;
    store.append(entry({ path: 'second.txt' }));
    // Unknown length: assume a fragment. A needless newline costs a blank
    // line readIndex skips; a missing one loses the entry.
    expect(readFileSync(indexPath, 'utf8').startsWith(`${before}\n`)).toBe(
      true,
    );
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('repairs the tail when the last byte cannot be read', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    hooks.failReadRange = (path) => path === indexPath;
    store.append(entry({ path: 'second.txt' }));
    // A torn read is the same as a torn tail: repair, never guess.
    expect(readFileSync(indexPath, 'utf8').startsWith(`${before}\n`)).toBe(
      true,
    );
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('repairs the tail when the bridge cannot read a byte range', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    hooks.withoutReadFileRange = true;
    store.append(entry({ path: 'first.txt' }));
    const indexPath = join(dir, 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    store.append(entry({ path: 'second.txt' }));
    // No pread seam: the tail is uninspectable, so it is repaired.
    expect(readFileSync(indexPath, 'utf8').startsWith(`${before}\n`)).toBe(
      true,
    );
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('leaves a torn index exactly as it was when the repairing append fails', () => {
    const dir = tempDir('journal-torn-');
    const store = new FileJournalStore(dir);
    const indexPath = join(dir, 'index.jsonl');
    store.append(entry({ path: 'first.txt' }));
    appendFileSync(indexPath, '{"path":"torn');
    const torn = readFileSync(indexPath, 'utf8');
    hooks.failAppend = (path) => path === indexPath;
    expect(() => store.append(entry({ path: 'second.txt' }))).toThrow(/ENOSPC/);
    // Prior length — the repair newline the failed append carried is gone
    // with the rest of the partial write, so the tail is exactly as before.
    expect(readFileSync(indexPath, 'utf8')).toBe(torn);
    // The retry repairs the tail again and the entry becomes readable.
    store.append(entry({ path: 'second.txt' }));
    expect(store.entries().map((e) => e.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });
});
