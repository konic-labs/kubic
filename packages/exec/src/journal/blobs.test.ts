// The content-addressed blob store over a temp directory: writes, verified
// reads, healing a torn blob, and the sweep after a retention rewrite.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../file-bridge.js';
import { BlobStore } from './blobs.js';
import { sha256Hex } from './hash.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function blobDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'journal-blobs-'));
  made.push(dir);
  return dir;
}

const bridge = createNodeFileBridge('/');

describe('BlobStore', () => {
  it('stores content under its hash, private, and reads it back verified', () => {
    const dir = blobDir();
    const blobs = new BlobStore(dir, true);
    const hash = sha256Hex('hello');
    blobs.put(bridge, hash, 'hello');
    expect(readFileSync(join(dir, hash), 'utf8')).toBe('hello');
    expect(statSync(join(dir, hash)).mode & 0o777).toBe(0o600);
    expect(blobs.read(hash)).toBe('hello');
    expect(blobs.has(hash)).toBe(true);
    expect(blobs.count()).toBe(1);
  });

  it('refuses a blob whose content no longer matches its name', () => {
    const dir = blobDir();
    const blobs = new BlobStore(dir, true);
    const hash = sha256Hex('original');
    blobs.put(bridge, hash, 'original');
    writeFileSync(join(dir, hash), 'tampered');
    const corrupt: string[] = [];
    expect(blobs.read(hash, (detail) => corrupt.push(detail))).toBeNull();
    expect(corrupt).toEqual([
      `blob ${hash} fails its own hash — treating as missing`,
    ]);
  });

  it('rewrites a torn blob found at its address from the bytes in hand', () => {
    const dir = blobDir();
    const hash = sha256Hex('content');
    // A crash left a zero-length file under the right name.
    writeFileSync(join(dir, hash), '');
    new BlobStore(dir, true).put(bridge, hash, 'content');
    expect(readFileSync(join(dir, hash), 'utf8')).toBe('content');
  });

  it('measures each referenced blob once', () => {
    const dir = blobDir();
    const blobs = new BlobStore(dir, false);
    const a = sha256Hex('aaaa');
    const b = sha256Hex('bb');
    blobs.put(bridge, a, 'aaaa');
    blobs.put(bridge, b, 'bb');
    const entry = (before: string | null, after: string | null) => ({
      path: 'f',
      op: 'write' as const,
      beforeHash: before,
      afterHash: after,
      deltaHash: null,
      bytesDelta: 0,
      sessionId: 's',
      source: 'tool' as const,
      toolCallId: null,
      timestamp: 1,
    });
    expect(blobs.bytes(bridge, [entry(a, b), entry(b, a)])).toBe(6);
    expect(blobs.sizeOf(bridge, 'missing')).toBe(0);
  });

  it('sweeps unreferenced blobs, keeps referenced and in-flight ones', () => {
    const dir = blobDir();
    const blobs = new BlobStore(dir, false);
    const kept = sha256Hex('kept');
    const dropped = sha256Hex('dropped');
    blobs.put(bridge, kept, 'kept');
    blobs.put(bridge, dropped, 'dropped');
    // An orphan no entry ever referenced, and another process's tmp.
    writeFileSync(join(dir, 'orphan'), 'xyz');
    writeFileSync(join(dir, `${kept}.123.tmp`), 'partial');
    const orphanBytes = blobs.sweep(
      bridge,
      new Set([kept]),
      new Set([kept, dropped]),
    );
    expect(blobs.has(kept)).toBe(true);
    expect(blobs.has(dropped)).toBe(false);
    expect(blobs.has('orphan')).toBe(false);
    expect(blobs.has(`${kept}.123.tmp`)).toBe(true);
    // Only the orphan counts: a dropped entry's blob is freed bytes the
    // caller already accounted for.
    expect(orphanBytes).toBe(3);
  });
});
