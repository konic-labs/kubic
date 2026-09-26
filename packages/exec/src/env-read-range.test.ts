// Ranged reads on the ExecutionEnv seam (issue #122).
// Mirrors #107's FileBridge.readFileRange exactly — same
// openSync/readSync/closeSync + confine() technique — so read windowing
// costs one chunk of memory, not the file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from './env.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kubic-env-range-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NodeFileSystem.readFileRange (issue #122)', () => {
  it('returns exactly the requested [start, end) byte window', () => {
    writeFileSync(join(dir, 'data.bin'), Buffer.from('abcdefghij'));
    const env = new NodeExecutionEnv(dir);
    const out = env.fs.readFileRange?.('data.bin', 2, 5);
    expect(Array.from(out ?? [])).toEqual([99, 100, 101]); // 'cde'
  });

  it('returns a short slice at EOF and an empty slice past it', () => {
    writeFileSync(join(dir, 'short.bin'), Buffer.from('abc'));
    const env = new NodeExecutionEnv(dir);
    expect(
      Array.from(env.fs.readFileRange?.('short.bin', 1, 99) ?? []),
    ).toEqual([98, 99]);
    expect(Array.from(env.fs.readFileRange?.('short.bin', 3, 9) ?? [])).toEqual(
      [],
    );
    expect(Array.from(env.fs.readFileRange?.('short.bin', 3, 3) ?? [])).toEqual(
      [],
    );
  });

  it('confines ranges to the cwd like every other fs call', () => {
    writeFileSync(join(dir, 'x.bin'), Buffer.from('abc'));
    const env = new NodeExecutionEnv(dir);
    expect(() => env.fs.readFileRange?.('../x.bin', 0, 1)).toThrow(
      /escapes cwd confinement/,
    );
  });
});
