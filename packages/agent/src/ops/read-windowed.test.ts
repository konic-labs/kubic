// Bounded read windowing.
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
  writeSync,
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
// Spec bounds, pinned as literals so the test stands apart
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

describe('bounded read windowing', () => {
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
      'single.txt': 'lane',
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
    // Exact shape — the fallback gains no new fields (required or not),
    // and the file's trailing '\n' is not doubled.
    expect(out).toEqual({
      path: 'plain.txt',
      content: 'red\ngreen\n',
      offset: 1,
      totalLines: 2,
      truncated: false,
    });
  });

  it('keeps a blank line distinct from an empty file', async () => {
    writeFileSync(join(dir, 'blank.txt'), '\n');
    writeFileSync(join(dir, 'empty.txt'), '');
    const ctx = countingEnv(false);
    const blank = await readOperation.execute(
      inv(),
      { path: 'blank.txt' },
      ctx,
    );
    const empty = await readOperation.execute(
      inv(),
      { path: 'empty.txt' },
      ctx,
    );
    expect(blank.content).toBe('\n');
    expect(empty.content).toBe('');
  });

  it('keeps the last line of a file without a trailing newline', async () => {
    writeFileSync(join(dir, 'open.txt'), 'one\ntwo');
    const out = await readOperation.execute(
      inv(),
      { path: 'open.txt' },
      countingEnv(false),
    );
    expect(out.content).toBe('one\ntwo\n');
    expect(out.totalLines).toBe(2);
  });
});

// totalLines/truncated honesty: truncated:false
// implies totalLines is exact AND content is complete for the requested
// region. truncated:true whenever the scan stopped before EOF — budget,
// line cap, or limit-stopped region collection — and totalLines is then a
// lower bound ("lines confirmed so far").
describe('totalLines/truncated honesty', () => {
  it('flags truncated when region collection stops at exactly READ_MAX_LINES newlines at a chunk boundary', async () => {
    // 1999 × 262-byte lines + one 550-byte line = exactly 524288 bytes =
    // one chunk: region collection stops with exactly 2000 newlines at the
    // chunk boundary while 3000 lines follow unseen.
    const head =
      Array.from({ length: 1999 }, () => `${'a'.repeat(261)}\n`).join('') +
      `${'a'.repeat(549)}\n`;
    const tail = Array.from(
      { length: 3000 },
      () => `${'b'.repeat(261)}\n`,
    ).join('');
    writeFileSync(join(dir, 'boundary.txt'), head + tail);
    const out = await readOperation.execute(
      inv(),
      { path: 'boundary.txt' },
      countingEnv(true),
    );
    // The count is only the lines the scan confirmed...
    expect(out.totalLines).toBe(2000);
    // ...and the flag must say the scan stopped before EOF, never compare
    // that lower bound against READ_MAX_LINES.
    expect(out.truncated).toBe(true);
  });

  it('flags truncated and labels a lower bound on a limit-stopped scan past one chunk', async () => {
    // 10000 × 100-byte lines (~1 MiB): the first 512 KiB chunk holds 5242
    // complete lines and starts line 5243.
    const line = (n: number): string => {
      const text = String(n).padStart(6, '0').padEnd(99, 'x');
      return `${text}\n`;
    };
    writeFileSync(
      join(dir, 'wide.txt'),
      Array.from({ length: 10_000 }, (_, i) => line(i + 1)).join(''),
    );
    const out = await readOperation.execute(
      inv(),
      { path: 'wide.txt', offset: 1, limit: 10 },
      countingEnv(true),
    );
    // The requested region is delivered in full...
    expect(out.content).toBe(
      Array.from({ length: 10 }, (_, i) => line(i + 1)).join(''),
    );
    // ...but the scan stopped before EOF, so truncated must be true and the
    // count is a lower bound of lines confirmed so far (5242 complete +
    // line 5243 started in the scanned bytes).
    expect(out.truncated).toBe(true);
    expect(out.totalLines).toBe(5243);
  });

  it('counts a line that starts in the scan but extends beyond the budget', async () => {
    // A 9 MiB single line followed by '\nb\nc\n'; the 8 MiB budget stops
    // mid-line-1. No real 9 MiB content: the bytes before the tail are a
    // sparse hole.
    sparseFile('giant-line.txt', 9 * MIB);
    const handle = openSync(join(dir, 'giant-line.txt'), 'r+');
    try {
      writeSync(handle, Buffer.from('\nb\nc\n'), 0, 5, 9 * MIB);
    } finally {
      closeSync(handle);
    }
    const out = await readOperation.execute(
      inv(),
      { path: 'giant-line.txt', offset: 1 },
      countingEnv(true),
    );
    // The partial line is never handed out...
    expect(out.content).toBe('');
    expect(out.truncated).toBe(true);
    // ...but line 1 starts at byte 0 and extends beyond the budget, so it
    // counts: at least one line is confirmed.
    expect(out.totalLines).toBe(1);
  });

  it('does not count a line that never started when the budget ends on a newline', async () => {
    // Exactly 8 MiB = 32768 × 256-byte lines: the budget is spent on a
    // newline, so no 32769th line ever starts within the scanned bytes.
    writeFileSync(
      join(dir, 'exact-bound.txt'),
      Array.from({ length: 32_768 }, () => `${'a'.repeat(255)}\n`).join(''),
    );
    const out = await readOperation.execute(
      inv(),
      { path: 'exact-bound.txt', offset: 100_000 },
      countingEnv(true),
    );
    expect(out.content).toBe('');
    expect(out.truncated).toBe(true);
    expect(out.totalLines).toBe(32_768);
  });
});
