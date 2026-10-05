// The lock primitive's failure path (issue #337 review fix 1).
//
// `withFileLocked` creates the lock with O_EXCL and then writes its pid. When
// that write fails (ENOSPC/EIO on a full or failing disk) the fd was left open
// and the lock file behind: a leaked descriptor per attempt for a long-lived
// run, and a lock nobody can take for the whole stale window. The write is
// guarded now — fd closed, lock removed, error rethrown — and the next attempt
// succeeds.
//
// RED: the pid write sits between the create and the try/finally, so a throw
// leaves both the descriptor and the lock file.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFileLocked } from './file-bridge.js';

const hooks = vi.hoisted(() => ({
  failWrite: false,
  closes: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (hooks.failWrite) {
        const error: NodeJS.ErrnoException = new Error('no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      return actual.writeSync(...args);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      hooks.closes += 1;
      return actual.closeSync(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  hooks.failWrite = false;
  hooks.closes = 0;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'with-lock-'));
  roots.push(root);
  return join(root, 'sub', 'lock.json');
}

describe('withFileLocked failure path (issue #337 review)', () => {
  it('closes the descriptor and removes the lock when the pid write fails', () => {
    const path = lockPath();
    hooks.failWrite = true;
    let ran = false;
    expect(() =>
      withFileLocked(path, () => {
        ran = true;
        return 'body';
      }),
    ).toThrow(/no space left/);
    // The body never ran, the descriptor was closed, the lock is gone.
    expect(ran).toBe(false);
    expect(hooks.closes).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('takes the lock normally on the next attempt', () => {
    const path = lockPath();
    hooks.failWrite = true;
    expect(() => withFileLocked(path, () => 'first')).toThrow(/no space left/);
    hooks.failWrite = false;
    // Not blocked by a lock the failed attempt left behind.
    expect(withFileLocked(path, () => 'second')).toBe('second');
    expect(existsSync(path)).toBe(false);
  });

  it('still writes the pid and removes the lock on the happy path', () => {
    const path = lockPath();
    expect(withFileLocked(path, () => readFileSync(path, 'utf8'))).toBe(
      String(process.pid),
    );
    expect(existsSync(path)).toBe(false);
    expect(statSync(join(path, '..')).isDirectory()).toBe(true);
  });
});
