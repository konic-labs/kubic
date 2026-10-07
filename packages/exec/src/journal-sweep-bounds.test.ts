// Sweep content bound + lossy-decode guard.
//
// Bounded the walk's HASHING; the sweep's after-content READ stayed whole-file,
// so a changed multi-hundred-MB artifact still cost its size in memory on the
// run's exit path, and binary files were stored as mangled text. This file pins
// the sweep bound: at or under MAX_SWEEP_CONTENT_BYTES a changed file is read
// whole and its after-content stored; above it — or when the utf-8 round-trip
// is lossy — the entry is hash-only (`after: null`, the walk hash intact) and
// `diff` renders a size-only change.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, type FileBridge } from './file-bridge.js';
import {
  captureBaseline,
  FileJournalStore,
  MAX_SWEEP_CONTENT_BYTES,
  reconcile,
  sha256Hex,
  sha256HexOfFile,
} from './journal.js';
import { diffEntries, renderDiff } from './journal-diff.js';
import { captureGitBaseline, type GitCommand } from './journal-git.js';
import { renderLog } from './journal-status.js';

const CTX = {
  sessionId: 's-sweep-bounds',
  agentId: 'root',
  timestamp: 1_700_000_000_000,
};

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-sweep-bounds-'));
  roots.push(root);
  return root;
}

function journalStore(): FileJournalStore {
  const dir = mkdtempSync(join(tmpdir(), 'j-sweep-bounds-'));
  roots.push(dir);
  return new FileJournalStore(dir);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Read-size-observing double: counts every read the
// sweep asks the bridge for, so "never reads above the bound" is observed,
// not assumed. Wraps the real node bridge, so the read still happens.
function spyReads(): {
  bridge: FileBridge;
  state: { maxRead: number; textReads: string[] };
} {
  const inner = createNodeFileBridge('/');
  const state = { maxRead: 0, textReads: [] as string[] };
  const counted = (length: number): void => {
    state.maxRead = Math.max(state.maxRead, length);
  };
  const bridge: FileBridge = {
    ...inner,
    readTextFile: (path: string): string => {
      const text = inner.readTextFile(path);
      counted(Buffer.byteLength(text, 'utf8'));
      state.textReads.push(path);
      return text;
    },
    readFileRange: (path: string, start: number, end: number): Uint8Array => {
      const bytes = inner.readFileRange?.(path, start, end);
      if (bytes === undefined)
        throw new Error('node bridge must implement readFileRange');
      counted(bytes.length);
      return bytes;
    },
    readBinaryFile: (path: string): Uint8Array => {
      const bytes = inner.readBinaryFile(path);
      counted(bytes.length);
      return bytes;
    },
  };
  return { bridge, state };
}

// Acceptance invariant: for every entry with retrievable after-content,
// its hash is exactly what the entry claims.
function expectAfterHashConsistent(store: FileJournalStore): void {
  for (const e of store.entries()) {
    const after = store.readAfter(e);
    if (after !== null) expect(sha256Hex(after)).toBe(e.afterHash);
  }
}

describe('sweep content bound', () => {
  it('never reads a changed file above the bound; records it hash-only with the walk hash', () => {
    const size = MAX_SWEEP_CONTENT_BYTES + 1024 * 1024;
    const root = tmpRoot();
    const abs = join(root, 'big.bin');
    writeFileSync(abs, 'a'.repeat(size));
    const inner = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge: inner });
    // The change the sweep must find (sed -i equivalent: bypasses Kubic ops).
    writeFileSync(abs, 'b'.repeat(size));
    const spy = spyReads();
    const store = journalStore();
    const added = reconcile(store, baseline, root, CTX, { bridge: spy.bridge });
    expect(added).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing big.bin entry');
    // Hash-only: no after-content, but the walk hash is recorded intact.
    expect(store.readAfter(entry)).toBe(null);
    expect(entry.afterHash).toBe(sha256HexOfFile(inner, abs, size));
    expect(entry.afterOmitted).toBe(true);
    expect(entry.afterBytes).toBe(size);
    expect(entry.beforeHash).toBe(baseline['big.bin']);
    // Zero reads above the bound: the 5 MiB file is streamed by the walk in
    // chunks and never read whole by the sweep.
    expect(spy.state.maxRead).toBeLessThanOrEqual(MAX_SWEEP_CONTENT_BYTES);
    expect(spy.state.textReads.some((path) => path.endsWith('big.bin'))).toBe(
      false,
    );
  });

  it('captures the full after-content of a changed file at or under the bound', () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'small.txt'), 'before\n');
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'small.txt'), 'after\n');
    const store = journalStore();
    const added = reconcile(store, baseline, root, CTX);
    expect(added).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing small.txt entry');
    expect(store.readAfter(entry)).toBe('after\n');
    expect(entry.afterHash).toBe(sha256Hex('after\n'));
    expect(entry.afterOmitted).toBeUndefined();
    expectAfterHashConsistent(store);
  });

  it('boundary: exactly MAX_SWEEP_CONTENT_BYTES is still captured; one byte above is hash-only', () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'at.bin'), 'a'.repeat(MAX_SWEEP_CONTENT_BYTES));
    writeFileSync(
      join(root, 'above.bin'),
      'c'.repeat(MAX_SWEEP_CONTENT_BYTES + 1),
    );
    const inner = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge: inner });
    writeFileSync(join(root, 'at.bin'), 'b'.repeat(MAX_SWEEP_CONTENT_BYTES));
    writeFileSync(
      join(root, 'above.bin'),
      'd'.repeat(MAX_SWEEP_CONTENT_BYTES + 1),
    );
    const spy = spyReads();
    const store = journalStore();
    const added = reconcile(store, baseline, root, CTX, { bridge: spy.bridge });
    expect(added).toBe(2);
    const at = store.entries().find((e) => e.path === 'at.bin');
    const above = store.entries().find((e) => e.path === 'above.bin');
    if (at === undefined || above === undefined)
      throw new Error('missing boundary entries');
    // At the bound: read whole, content stored (the bound is inclusive, in
    // the same spirit as HASH_CHUNK_BYTES's "at or under").
    expect(store.readAfter(at)).toBe('b'.repeat(MAX_SWEEP_CONTENT_BYTES));
    expect(at.afterOmitted).toBeUndefined();
    // One byte above: hash-only, and the sweep never read it.
    expect(store.readAfter(above)).toBe(null);
    expect(above.afterOmitted).toBe(true);
    expect(above.afterBytes).toBe(MAX_SWEEP_CONTENT_BYTES + 1);
    expect(spy.state.textReads.some((path) => path.endsWith('above.bin'))).toBe(
      false,
    );
    expect(spy.state.maxRead).toBeLessThanOrEqual(MAX_SWEEP_CONTENT_BYTES);
    expectAfterHashConsistent(store);
  });

  it('never stores a lossy decode: binary content is hash-only, never mangled text', () => {
    // Invalid UTF-8 plus a NUL: `readTextFile` decodes this to U+FFFD-
    // mangled text, and the old sweep stored that mangled string as the
    // after-blob. The guard is exact: the decode is lossless iff the bytes
    // are exactly the utf-8 re-encoding of the decoded string.
    const binary = Buffer.from([
      0x61, 0x62, 0xff, 0xfe, 0x00, 0x63, 0x80, 0x81,
    ]);
    const root = tmpRoot();
    const abs = join(root, 'asset.bin');
    writeFileSync(abs, 'plain\n');
    const inner = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge: inner });
    writeFileSync(abs, binary);
    const store = journalStore();
    const added = reconcile(store, baseline, root, CTX);
    expect(added).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing asset.bin entry');
    // No after-content, but the walk hash (over the utf-8 decode) is intact.
    expect(store.readAfter(entry)).toBe(null);
    expect(entry.afterOmitted).toBe(true);
    expect(entry.afterBytes).toBe(binary.length);
    expect(entry.afterHash).toBe(sha256HexOfFile(inner, abs, binary.length));
    expect(entry.beforeHash).toBe(baseline['asset.bin']);
    // Nothing was written at all: no mangled blob for `diff` to serve.
    expect(store.blobCount()).toBe(0);
    const changes = diffEntries(store, {});
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change === undefined) throw new Error('missing change');
    expect(change.corrupt).toBe(false);
    const text = renderDiff(changes);
    expect(text).toContain(
      `[content not captured — ${binary.length} bytes changed]`,
    );
    expect(text).not.toContain('\uFFFD');
  });

  it('does not re-record a hash-only entry on a second sweep (the walk hash is intact)', () => {
    const size = MAX_SWEEP_CONTENT_BYTES + 1024 * 1024;
    const root = tmpRoot();
    writeFileSync(join(root, 'big.bin'), 'a'.repeat(size));
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'big.bin'), 'b'.repeat(size));
    const store = journalStore();
    expect(reconcile(store, baseline, root, CTX)).toBe(1);
    // The entry's afterHash is the walk hash, so an unchanged tree dedupes
    // exactly like a content-captured entry does.
    expect(reconcile(store, baseline, root, CTX)).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  it('renders a hash-only entry as a size-only change and logs it as today', () => {
    const size = MAX_SWEEP_CONTENT_BYTES + 1024 * 1024;
    const root = tmpRoot();
    writeFileSync(join(root, 'big.bin'), 'a'.repeat(size));
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'big.bin'), 'b'.repeat(size));
    const store = journalStore();
    reconcile(store, baseline, root, CTX);
    const changes = diffEntries(store, {});
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change === undefined) throw new Error('missing change');
    // A designed absence, not corruption (the entry records the hash).
    expect(change.corrupt).toBe(false);
    expect(change.afterOmitted).toBe(true);
    expect(change.afterBytes).toBe(size);
    const text = renderDiff(changes);
    expect(text).toContain(`[content not captured — ${size} bytes changed]`);
    expect(text).toContain('[unattributed, non-reversible]');
    // No hunks: there is no content to show, and nothing is invented.
    expect(text).not.toContain('@@');
    // `kubic log` keeps today's `+NB` delta shape for the entry.
    expect(renderLog(store).join('\n')).toContain('big.bin +0B reconciled');
  });
});

describe('git baseline cost', () => {
  it('stays a metadata walk: two git calls and no blob reads, however many files the repo holds', () => {
    const root = tmpRoot();
    const fileCount = 50;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(root, `f${i}.ts`), `content ${i}\n`);
    }
    const baseline = captureBaseline(root);
    expect(Object.keys(baseline)).toHaveLength(fileCount);
    const ls = Object.keys(baseline)
      .map((p, i) => `100644 ${(i % 16).toString(16).repeat(40)} 0\t${p}`)
      .join('\0');
    const calls: string[][] = [];
    const run: GitCommand = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ls-files')
        return { status: 0, stdout: Buffer.from(`${ls}\0`, 'utf8') };
      if (args[0] === 'status') return { status: 0, stdout: Buffer.alloc(0) };
      return { status: 1, stdout: Buffer.alloc(0) };
    };
    const added = captureGitBaseline(root, baseline, run);
    // One ls-files for the whole repo, one status for the stat-clean check:
    // per-file cost is zero git I/O, and no blob is ever read at baseline.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('cat-file'))).toBe(false);
    expect(Object.keys(added ?? {})).toHaveLength(fileCount);
  });
});
