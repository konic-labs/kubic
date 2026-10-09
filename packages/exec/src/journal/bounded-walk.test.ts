// Bounded baseline hashing.
//
// Baseline capture and the end-of-run sweep hash every in-scope regular file.
// Reading whole files made a 256MB artifact cost a 256MB boot spike, measured
// (file=256MB → heapDelta=256.1MB). The walk streams in
// chunks, and the load-bearing property is that the digest is UNCHANGED: the
// baseline is compared against digests written by older versions, so a changed
// digest would read as "every file changed" and rewrite journal history.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, type FileBridge } from '../file-bridge.js';
import type { Baseline } from './baseline.js';
import { captureBaseline } from './baseline.js';
import { HASH_CHUNK_BYTES, HASH_NOTICE_BYTES, sha256Hex } from './hash.js';
import { FileJournalStore } from './store.js';
import { reconcile } from './sweep.js';

const CTX = {
  sessionId: 's-bounded',
  agentId: 'a-bounded',
  timestamp: 1_700_000_000_000,
};

const roots: string[] = [];

function tmpFile(name: string, content: string | Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-bounded-walk-'));
  roots.push(root);
  writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The pre digest: whole-file read, utf8 round-trip, hashed as a string. */
function legacyHash(bridge: FileBridge, path: string): string {
  return createHash('sha256')
    .update(bridge.readTextFile(path), 'utf8')
    .digest('hex');
}

/** Records the largest single read the walk asks for. */
function spyReads(): {
  bridge: FileBridge;
  maxRead: number;
  totalRead: number;
} {
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
      if (bytes === undefined)
        throw new Error('node bridge must implement readFileRange');
      counted(bytes.length);
      return bytes;
    },
  };
  return {
    bridge,
    get maxRead() {
      return state.maxRead;
    },
    get totalRead() {
      return state.totalRead;
    },
  } as { bridge: FileBridge; maxRead: number; totalRead: number };
}

describe('bounded baseline hashing', () => {
  it('never reads more than one chunk of a file larger than the chunk', () => {
    const size = HASH_CHUNK_BYTES * 2 + 1;
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
    const root = tmpFile(
      'straddle.txt',
      `${'a'.repeat(HASH_CHUNK_BYTES - 1)}é${'z'.repeat(1024)}`,
    );
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge });
    expect(baseline['straddle.txt']).toBe(
      legacyHash(bridge, join(root, 'straddle.txt')),
    );
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
    expect(baseline['binary.bin']).toBe(
      legacyHash(bridge, join(root, 'binary.bin')),
    );
  });

  it('ships a bridge that can read a range: the bound depends on it', () => {
    // Without this the walk silently falls back to whole-file reads, which is
    // the defect — so the contract is pinned rather than assumed.
    expect(typeof createNodeFileBridge('/').readFileRange).toBe('function');
  });

  it('keeps the digest byte-identical when the file starts with a UTF-8 BOM', () => {
    // `TextDecoder('utf-8')` STRIPS a leading BOM
    // while `readFileSync(path, 'utf8')` keeps it as U+FEFF, so a BOM-prefixed
    // file above the chunk size must hash the same as a whole-file read, or every
    // file reads as changed and the journal history is rewritten. A BOM-prefixed
    // CSV/JSON export is all it takes.
    const body = 'a'.repeat(HASH_CHUNK_BYTES * 2);
    const root = tmpFile('bom.csv', `\uFEFF${body}`);
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge });
    expect(baseline['bom.csv']).toBe(legacyHash(bridge, join(root, 'bom.csv')));
  });

  it('does not treat crossing the chunk threshold as a change for a BOM file', () => {
    // Same leading bytes, one below and one above the chunk: both must hash
    // like the legacy whole-file read, so a file that merely grew past the
    // window is indistinguishable from itself.
    const below = tmpFile('below.csv', `\uFEFF${'a'.repeat(1024)}`);
    const above = tmpFile(
      'above.csv',
      `\uFEFF${'a'.repeat(HASH_CHUNK_BYTES + 1024)}`,
    );
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(below, { bridge });
    const streamed = captureBaseline(above, { bridge })['above.csv'];
    expect(baseline['below.csv']).toBe(
      legacyHash(bridge, join(below, 'below.csv')),
    );
    expect(streamed).toBe(legacyHash(bridge, join(above, 'above.csv')));
  });

  it('flushes a truncated multi-byte sequence at EOF like the whole-file read', () => {
    // A sequence cut off at exact EOF: the streaming decoder holds the bytes
    // back, and only the final flush (`decoder.decode()`) emits U+FFFD.
    const bytes = new Uint8Array(HASH_CHUNK_BYTES + 8);
    bytes.fill(0x61);
    // A 3-byte character truncated to its first byte at the very end.
    bytes[HASH_CHUNK_BYTES + 7] = 0xe2;
    const root = tmpFile('truncated-eof.bin', bytes);
    const bridge = createNodeFileBridge('/');
    const baseline = captureBaseline(root, { bridge });
    expect(baseline['truncated-eof.bin']).toBe(
      legacyHash(bridge, join(root, 'truncated-eof.bin')),
    );
  });

  it('hashes only what was read when the file shrinks mid-hash', () => {
    // A short read must not be zero-padded and hashed as NULs
    // (`buffer.subarray(0, read)`). Simulated by a
    // bridge whose range read returns fewer bytes than requested, which is
    // what a file truncated between the size probe and the read produces.
    const root = tmpFile('shrinks.bin', 'a'.repeat(HASH_CHUNK_BYTES * 2));
    const inner = createNodeFileBridge('/');
    const bridge: FileBridge = {
      ...inner,
      readFileRange: (path: string, start: number, end: number): Uint8Array => {
        const bytes = inner.readFileRange?.(path, start, end);
        if (bytes === undefined) throw new Error('need a range read');
        // The first window comes back half-length, as if the file shrank
        // between the size probe and the read.
        return start === 0
          ? bytes.subarray(0, Math.floor(bytes.length / 2))
          : bytes;
      },
    };
    const baseline = captureBaseline(root, { bridge });
    // The digest must equal hashing exactly the bytes that came back (half
    // the first window, then the whole second one), never a zero-padded window.
    expect(baseline['shrinks.bin']).toBe(
      sha256Hex('a'.repeat(HASH_CHUNK_BYTES / 2 + HASH_CHUNK_BYTES)),
    );
  });

  it('names a very large file instead of hashing it silently', () => {
    // A sparse file (4 GiB apparent, 0 real blocks) costs its apparent size in boot I/O.
    // Memory stays bounded, and the walk reports that cost. The notice keys off the size the
    // bridge's listing reports, so a double reports an apparent size above the
    // threshold for a tiny real file: the walk still streams it through range
    // reads, without the test paying ~256 MiB of zero-hashing.
    const root = tmpFile('sparse.bin', 'tiny-real-content\n');
    const inner = createNodeFileBridge('/');
    const realSize = Buffer.byteLength('tiny-real-content\n');
    const apparent: FileBridge = {
      ...inner,
      listDir: (path: string) =>
        inner
          .listDir(path)
          .map((info) =>
            info.name === 'sparse.bin'
              ? { ...info, size: HASH_NOTICE_BYTES + 1 }
              : info,
          ),
      readFileRange: (path: string, start: number, end: number) =>
        start >= realSize
          ? new Uint8Array(0)
          : (inner.readFileRange?.(path, start, end) ?? new Uint8Array(0)),
    };
    const notices: string[] = [];
    const baseline = captureBaseline(root, {
      bridge: apparent,
      onNotice: (detail) => notices.push(detail),
    });
    // Hashed anyway (a skipped file would hide real changes)...
    expect(baseline['sparse.bin']).toBe(
      legacyHash(inner, join(root, 'sparse.bin')),
    );
    // ...and named exactly once, with its apparent size.
    expect(notices).toEqual([
      `hashing a very large file: sparse.bin (${HASH_NOTICE_BYTES + 1} bytes) — boot reads its full apparent size`,
    ]);
  });

  it('stays quiet for ordinary files', () => {
    // The notice must be a real signal, not boot noise.
    const root = tmpFile('small.txt', 'hello\n');
    const notices: string[] = [];
    captureBaseline(root, { onNotice: (detail) => notices.push(detail) });
    expect(notices).toEqual([]);
  });

  it('reports rather than silently reverting when a bridge cannot read ranges', () => {
    // A partial bridge must not quietly restore whole-file reads: the fallback is
    // announced through the notice hook.
    const root = tmpFile('big.txt', 'a'.repeat(HASH_CHUNK_BYTES * 2));
    const inner = createNodeFileBridge('/');
    const noRange: FileBridge = {
      ...inner,
      readFileRange: undefined,
    };
    const notices: string[] = [];
    const baseline = captureBaseline(root, {
      bridge: noRange,
      onNotice: (detail) => notices.push(detail),
    });
    // Still correct — just unbounded and now visible.
    expect(baseline['big.txt']).toBe(legacyHash(inner, join(root, 'big.txt')));
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/bounded hashing unavailable/);
    expect(notices[0]).toContain('big.txt');
  });

  it('routes the after-content read through the same bridge as the hash', () => {
    // The hash honours options.bridge, and reconcile's after-read must use the
    // same bridge, or an injected double sees only half the walk. One bridge
    // serves the whole reconcile.
    const root = tmpFile('changed.txt', 'before\n');
    const inner = createNodeFileBridge('/');
    const reads: string[] = [];
    const spy: FileBridge = {
      ...inner,
      readTextFile: (path: string): string => {
        reads.push(path);
        return inner.readTextFile(path);
      },
    };
    const store = new FileJournalStore(join(root, 'sessions'));
    // The file changes, so the sweep must read its after-content.
    writeFileSync(join(root, 'changed.txt'), 'after\n');
    const added = reconcile(
      store,
      { 'changed.txt': sha256Hex('before\n') },
      root,
      CTX,
      { bridge: spy },
    );
    expect(added).toBe(1);
    expect(reads.some((path) => path.endsWith('changed.txt'))).toBe(true);
  });

  it('appends nothing when sweeping over a journal hashed by the legacy digest', () => {
    // Compatibility: the walk must agree with a journal written by the legacy
    // digest. That digest is computed the legacy way and planted as the
    // baseline; if the walk disagreed by one byte, the sweep would report
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
