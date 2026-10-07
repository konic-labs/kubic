// Read on the real, unwrapped NodeExecutionEnv.
// The windowed read must call `fs.readFileRange` as a method — the real
// NodeFileSystem reads `this.cwd` — and the op's catch must name the actual
// failure: a missing path is `not_found`, a directory is `is_directory`, a
// permission refusal is `permission_denied`, anything else surfaces as-is.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { readFailure, readOperation, validateReadArgs } from './read.js';
import type { OpContext, ToolInvocation } from './types.js';
import { OpError } from './types.js';

let dir: string;

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

function ctxFor(env: NodeExecutionEnv): OpContext {
  return { env, sessionId: 's1', agentId: 'a1' };
}

async function failure(path: string): Promise<OpError> {
  const env = new NodeExecutionEnv(dir);
  try {
    await readOperation.execute(inv(), { path }, ctxFor(env));
  } catch (err) {
    if (err instanceof OpError) return err;
    throw err;
  }
  throw new Error('expected read to fail');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kubic-read-errors-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe('read on the unwrapped NodeExecutionEnv', () => {
  it('returns the content of an existing file', async () => {
    writeFileSync(join(dir, 'long.js'), 'one\ntwo\nthree\n');
    const env = new NodeExecutionEnv(dir);
    const out = await readOperation.execute(
      inv(),
      { path: 'long.js' },
      ctxFor(env),
    );
    expect(out.content).toBe('one\ntwo\nthree\n');
    expect(out.totalLines).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('takes the windowed-read path on the real NodeFileSystem', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\ny\nz\n');
    const env = new NodeExecutionEnv(dir);
    // spyOn keeps the receiver: the original runs with whatever `this` the
    // op calls it with, so an unbound call still fails here.
    const range = vi.spyOn(env.fs, 'readFileRange');
    const whole = vi.spyOn(env.fs, 'readFile');
    const out = await readOperation.execute(
      inv(),
      { path: 'a.txt', offset: 2, limit: 1 },
      ctxFor(env),
    );
    expect(out.content).toBe('y\n');
    expect(range.mock.calls.length).toBeGreaterThan(0);
    expect(whole).not.toHaveBeenCalled();
  });

  it('reports a nonexistent path as not_found', async () => {
    const err = await failure('missing.txt');
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('read: no such file: missing.txt');
  });

  it('reports a directory as is_directory, not a missing file', async () => {
    mkdirSync(join(dir, 'sub'));
    const err = await failure('sub');
    expect(err.code).toBe('is_directory');
    expect(err.message).not.toMatch(/no such file/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable file as permission_denied',
    async () => {
      writeFileSync(join(dir, 'secret.txt'), 'x\n');
      chmodSync(join(dir, 'secret.txt'), 0o000);
      const err = await failure('secret.txt');
      expect(err.code).toBe('permission_denied');
      expect(err.message).not.toMatch(/no such file/);
    },
  );

  it('does not disguise other failures as a missing file', async () => {
    const env = new NodeExecutionEnv(dir);
    vi.spyOn(env.fs, 'readFileRange').mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(
      readOperation.execute(inv(), { path: 'a.txt' }, ctxFor(env)),
    ).rejects.toThrow(TypeError);
  });

  it('names each errno mapping with its own message', async () => {
    writeFileSync(join(dir, 'file.txt'), 'x\n');
    const notDir = await failure('file.txt/inner');
    expect(notDir.code).toBe('not_found');
    expect(notDir.message).toBe('read: no such file: file.txt/inner');
    mkdirSync(join(dir, 'sub'));
    expect((await failure('sub')).message).toBe(
      'read: sub is a directory (use ls to list it)',
    );
    const perm = readFailure(
      Object.assign(new Error('nope'), { code: 'EPERM' }),
      'p.txt',
    );
    expect(perm).toBeInstanceOf(OpError);
    expect((perm as OpError).code).toBe('permission_denied');
    expect((perm as OpError).message).toBe('read: permission denied: p.txt');
    const acces = readFailure({ code: 'EACCES' }, 'q.txt');
    expect((acces as OpError).code).toBe('permission_denied');
  });

  it('reports a cwd-confinement escape as invalid_args', async () => {
    const err = await failure('../outside.txt');
    expect(err.code).toBe('invalid_args');
    expect(err.message).toBe(
      'read: path escapes cwd confinement: ../outside.txt',
    );
    // Only a message that STARTS with the marker is a confinement refusal.
    const other = new Error('boom: path escapes cwd confinement');
    expect(readFailure(other, 'x')).toBe(other);
  });

  it('propagates non-Error throws and code-less errors unchanged', () => {
    expect(readFailure(null, 'x')).toBeNull();
    const plain = new Error('plain');
    expect(readFailure(plain, 'x')).toBe(plain);
    const odd = { code: 'EIO' };
    expect(readFailure(odd, 'x')).toBe(odd);
  });
});

describe('read argument validation', () => {
  it.each([
    [{ path: 'a', offset: 0 }, 'read: offset must be a 1-indexed integer'],
    [{ path: 'a', offset: 1.5 }, 'read: offset must be a 1-indexed integer'],
    [{ path: 'a', limit: 0 }, 'read: limit must be a positive integer'],
    [{ path: 'a', limit: 2.5 }, 'read: limit must be a positive integer'],
    [{ path: '' }, 'read: path must be a non-empty string'],
    [
      { path: 'a', extra: 1 },
      'read: unknown argument "extra" (strict sampling)',
    ],
    [null, 'read args must be an object'],
    [[], 'read args must be an object'],
  ])('refuses %j', (raw, message) => {
    expect(() => validateReadArgs(raw)).toThrow(message);
  });

  it('accepts offset 1 and limit 1', () => {
    expect(validateReadArgs({ path: 'a', offset: 1, limit: 1 })).toEqual({
      path: 'a',
      offset: 1,
      limit: 1,
    });
  });
});
