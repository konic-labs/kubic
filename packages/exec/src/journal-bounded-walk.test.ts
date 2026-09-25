// Bounded baseline hashing (issue #107).
//
// Baseline capture and the end-of-run sweep hash every in-scope regular file.
// Reading whole files made a 256MB artifact cost a 256MB boot spike, measured
// (file=256MB → heapDelta=256.1MB) before this issue. The walk now streams in
// chunks, and the load-bearing property is that the digest is UNCHANGED: the
// baseline is compared against digests written by older versions, so a changed
// digest would read as "every file changed" and rewrite journal history.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, type FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  HASH_CHUNK_BYTES,
  LARGE_FILE_BYTES,
  type Baseline,
  captureBaseline,
  reconcile,
} from './journal.js';

const CTX = { sessionId: 's-bounded', agentId: 'a-bounded', timestamp: 1_700_000_000_000 };

const roots: string[] = [];

function tmpFile(name: string, content: string | Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-bounded-walk-'));
  roots.push(root);
  writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The pre-#107 digest: whole-file read, utf8 round-trip, hashed as a string. */
function legacyHash(bridge: FileBridge, path: string): string {
  return createHash('sha256').update(bridge.readTextFile(path), 'utf8').digest('hex');
}

/** Records the largest single read the walk asks for. */
function spyReads(): { bridge: FileBridge; maxRead: number; totalRead: number } {
  const inner = createNodeFileBridge('/');
  const state = { maxRead: 0, totalRead: 0 };
  const counted = (length: number): void => {
    state.maxRead = Math.max(state.maxRead, length);
    state.totalRead += length;
  };
  const bridge: FileBridge = {
    ...inner,
    readTextFile: (path: string): string => {
      const text = inner.readTextFile(path);
      counted(Buffer.byteLength(text, 'utf8'));
      return text;
    },
    readFileRange: (path: string, start: number, end: number): Uint8Array => {
      const bytes = inner.readFileRange?.(path, start, end);
      if (bytes === undefined) throw new Error('node bridge must implement readFileRange');
      counted(bytes.length);
      return bytes;
    },
  };
  return { bridge, get maxRead() {
    return state.maxRead;
  }, get totalRead() {
    return state.totalRead;
  } } as { bridge: FileBridge; maxRead: number; totalRead: number };
}

describe('bounded baseline hashing (#107)', () => {
  it('never reads more than one chunk of a file far larger than the chunk', () => {
    const size = HASH_CHUNK_BYTES * 3;
    const root = tmpFile('big.txt', 'a'.repeat(size));
    const spy = spyReads();
    const baseline = captureBaseline(root, { bridge: spy.bridge });
    expect(Object.keys(baseline)).toEqual(['big.txt']);
    // It really read the file (not skipped)...
    expect(spy.totalRead).toBeGreaterThanOrEqual(size);
    // ...and never held more than one chunk at a time.
    expect(spy.maxRead).toBeLessThanOrEqual(HASH_CHUNK_BYTES);
  });

  it('keeps the digest byte-identical for a multi-byte character straddling a chunk boundary', () => {
    // The 'é' is two bytes and begins exactly at the chunk boundary, so a
    // naive per-chunk utf8 decode would turn it into a replacement character.
    const root = tmpFile('straddle.txt', `${'a'.repeat(HASH_CHUNK_BYTES - 1)}é${'z'.repeat(1024)}`);
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge });
    expect(baseline['straddle.txt']).toBe(legacyHash(bridge, join(root, 'straddle.txt')));
  });

  it('keeps the digest byte-identical for content that is not valid UTF-8', () => {
    // A byte-hashing implementation would differ here: the legacy digest is
    // over the utf8 round-trip, where invalid sequences collapse to U+FFFD.
    const bytes = new Uint8Array(HASH_CHUNK_BYTES + 4096);
    bytes.fill(0x61);
    bytes[HASH_CHUNK_BYTES - 1] = 0xff;
    bytes[HASH_CHUNK_BYTES] = 0xfe;
    const root = tmpFile('binary.bin', bytes);
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge });
    expect(baseline['binary.bin']).toBe(legacyHash(bridge, join(root, 'binary.bin')));
  });

  it('bounds the heap cost of a large file instead of scaling with it', () => {
    const size = HASH_CHUNK_BYTES * 6;
    const root = tmpFile('large.txt', 'a'.repeat(size));
    const before = process.memoryUsage().heapUsed;
    captureBaseline(root, { bridge: createNodeFileBridge('/') });
    const delta = process.memoryUsage().heapUsed - before;
    // A whole-file read of this fixture would cost >= size. The bound is
    // generous (3 chunks) so the assertion is about the class, not noise.
    expect(delta).toBeLessThan(HASH_CHUNK_BYTES * 3);
    expect(size).toBeGreaterThan(LARGE_FILE_BYTES);
  });

  it('ships a bridge that can read a range: the bound depends on it', () => {
    // Without this the walk silently falls back to whole-file reads, which is
    // the defect — so the contract is pinned rather than assumed.
    expect(typeof createNodeFileBridge('/').readFileRange).toBe('function');
  });

  it('appends nothing when sweeping over a journal hashed by the pre-#107 code', () => {
    // The acceptance criterion: prove against a journal written BEFORE the
    // change. The legacy digest is computed the old way and planted as the
    // baseline; if the new walk disagreed by one byte, the sweep would report
    // every large file as changed and rewrite journal history.
    const root = tmpFile('legacy.txt', 'a'.repeat(HASH_CHUNK_BYTES * 2));
    const bridge = createNodeFileBridge('/');
    const abs = join(root, 'legacy.txt');
    const planted: Baseline = { 'legacy.txt': legacyHash(bridge, abs) };
    const store = new FileJournalStore(join(root, 'sessions'));
    const added = reconcile(store, planted, root, CTX, { bridge });
    expect(added).toBe(0);
    expect(store.entries()).toHaveLength(0);
  });
});
