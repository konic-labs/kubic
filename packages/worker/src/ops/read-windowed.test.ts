// Bounded read windowing (issue #122, slice 2; §9.1, #107).
// The line window caps the output; this caps the READ. With a ranged-read
// seam the op must seek to the offset line in chunks and collect the window
// — never whole-file readFile — costing at most one read-bound window plus
// a single chunk of overshoot, one buffer at a time.

import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  type FileSystem,
  NodeExecutionEnv,
  ROOT_PROVENANCE,
} from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { readOperation } from './read.js';
import type { OpContext, ToolInvocation } from './types.js';

const KIB = 1024;
const MIB = 1024 * 1024;
// Spec bounds (issue #122), pinned as literals so the test stands apart
// from the implementation constants.
const BOUND_MAX_BYTES = 8 * MIB;
const BOUND_CHUNK_BYTES = 512 * KIB;

interface ReadStats {
  wholeReads: number;
  rangeCalls: number;
  rangeBytes: number;
  maxBuffer: number;
}

let dir: string;
let stats: ReadStats;

function inv(id = 'inv-1'): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

// ExecutionEnv double that counts every byte the op pulls through the seam:
// whole-file readFile calls, ranged calls, total bytes, and the largest
// single buffer handed out (memory must never hold the file).
function countingEnv(withRange: boolean): OpContext {
  stats = { wholeReads: 0, rangeCalls: 0, rangeBytes: 0, maxBuffer: 0 };
  const base = new NodeExecutionEnv(dir);
  const baseFs = base.fs;
  const fs: FileSystem = {
    readFile: (path: string) => {
      stats.wholeReads += 1;
      return baseFs.readFile(path);
    },
    writeFile: (path: string, content: string) =>
      baseFs.writeFile(path, content),
    rename: (from: string, to: string) => baseFs.rename(from, to),
    listDir: (path: string) => baseFs.listDir(path),
    stat: (path: string) => baseFs.stat(path),
    ...(withRange
      ? {
          readFileRange: (
            path: string,
            start: number,
            end: number,
          ): Uint8Array => {
            const handle = openSync(join(dir, path), 'r');
            try {
              const length = Math.max(0, end - start);
              const buffer = Buffer.allocUnsafe(length);
              const read = readSync(handle, buffer, 0, length, start);
              stats.rangeCalls += 1;
              stats.rangeBytes += read;
              stats.maxBuffer = Math.max(stats.maxBuffer, read);
              return buffer.subarray(0, read);
            } finally {
              closeSync(handle);
            }
          },
        }
      : {}),
  };
  const env: ExecutionEnv = {
    cwd: dir,
    provenance: ROOT_PROVENANCE,
    shell: base.shell,
    withProvenance: base.withProvenance.bind(base),
    fs,
  };
  return { env, sessionId: 's1', agentId: 'a1' };
}

// Sparse fixture: logical size without real bytes.
function sparseFile(name: string, bytes: number): void {
  const handle = openSync(join(dir, name), 'w');
  try {
    ftruncateSync(handle, bytes);
  } finally {
    closeSync(handle);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kubic-read-window-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bounded read windowing (issue #122)', () => {
  it('never whole-reads and stays within the read bound on a deep offset into a >64 MiB file', async () => {
    sparseFile('huge.bin', 64 * MIB + MIB);
    const ctx = countingEnv(true);
    const out = await readOperation.execute(
      inv(),
      { path: 'huge.bin', offset: 1_000_000, limit: 10 },
      ctx,
    );
    // Whole-file readFile is never on the table...
    expect(stats.wholeReads).toBe(0);
    expect(stats.rangeCalls).toBeGreaterThan(0);
    // ...total I/O is bounded by the read bound + one chunk...
    expect(stats.rangeBytes).toBeLessThanOrEqual(
      BOUND_MAX_BYTES + BOUND_CHUNK_BYTES,
    );
    // ...and no single buffer ever holds more than one chunk.
    expect(stats.maxBuffer).toBeLessThanOrEqual(BOUND_CHUNK_BYTES);
    // The requested window is unreachable within the budget: empty content,
    // honestly flagged as truncated (the scan stopped early).
    expect(out.content).toBe('');
    expect(out.offset).toBe(1_000_000);
    expect(out.truncated).toBe(true);
  });

  it('returns exactly what whole-read returns for offset 1, limit 2000 over small line fixtures', async () => {
    const fixtures: Record<string, string> = {
      'simple.txt': 'alpha\nbeta\ngamma\n',
      'no-trailing.txt': 'one\ntwo\nthree',
      'blank-lines.txt': 'a\n\nb\n\n',
      'single.txt': 'solo',
      'empty.txt': '',
      'unicode.txt': 'héllo\nwörld\n',
      // Multi-byte codepoint straddling the chunk boundary.
      'straddle.txt': `${'x'.repeat(BOUND_CHUNK_BYTES - 1)}é\ntail\n`,
    };
    const cases = [
      [1, 2000],
      [1, 1],
      [2, 5],
      [5, 2],
      [10, 2000],
    ] as const;
    for (const [name, body] of Object.entries(fixtures)) {
      writeFileSync(join(dir, name), body);
      for (const [offset, limit] of cases) {
        const windowed = await readOperation.execute(
          inv(),
          { path: name, offset, limit },
          countingEnv(true),
        );
        const whole = await readOperation.execute(
          inv(),
          { path: name, offset, limit },
          countingEnv(false),
        );
        expect({ name, offset, limit, result: windowed }).toEqual({
          name,
          offset,
          limit,
          result: whole,
        });
      }
    }
  });

  it('falls back to whole reads when readFileRange is absent, with no new result fields', async () => {
    writeFileSync(join(dir, 'plain.txt'), 'red\ngreen\n');
    const ctx = countingEnv(false);
    const out = await readOperation.execute(
      inv(),
      { path: 'plain.txt', offset: 1, limit: 2000 },
      ctx,
    );
    expect(stats.wholeReads).toBe(1);
    expect(stats.rangeCalls).toBe(0);
    // Exact shape — the fallback gains no new fields (required or not).
    // (content carries today's trailing-newline normalization quirk: the
    // phantom trailing entry joins, then the body gains its own '\n'.)
    expect(out).toEqual({
      path: 'plain.txt',
      content: 'red\ngreen\n\n',
      offset: 1,
      totalLines: 2,
      truncated: false,
    });
  });
});
