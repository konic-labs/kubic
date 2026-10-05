// Exclusive lock-file primitive (issue #118; §21–§22): the raw I/O half of
// the session lock. Exec owns node:fs (I/O confinement, §9) — the worker's
// session-store keeps the semantics (liveness, stale-steal) and calls these.
// Hermetic: tmp dirs only, no process signalling anywhere.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLockFile,
  looseStateDirMode,
  readLockFile,
  removeLockFile,
} from './lock-file.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpFile(name = 'lock.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'lock-file-'));
  roots.push(root);
  return join(root, name);
}

describe('lock file primitive (issue #118)', () => {
  it('creates exclusively and never clobbers an existing lock', () => {
    const path = tmpFile();
    expect(createLockFile(path, '{"pid":1}')).toBe(true);
    expect(readLockFile(path)).toBe('{"pid":1}');
    // O_EXCL: the second create reports the conflict and leaves the content.
    expect(createLockFile(path, '{"pid":2}')).toBe(false);
    expect(readLockFile(path)).toBe('{"pid":1}');
  });

  it('creates the parent directory eagerly (the lock holds the dir open)', () => {
    // Two missing levels: the create itself must make them.
    const nested = tmpFile(join('session', 'fresh', 'lock.json'));
    expect(existsSync(join(nested, '..'))).toBe(false);
    expect(createLockFile(nested, 'x')).toBe(true);
    expect(readLockFile(nested)).toBe('x');
  });

  it('reads missing and torn contents as undefined, never throwing', () => {
    expect(readLockFile(tmpFile('no-such-lock-file.json'))).toBeUndefined();
    const torn = tmpFile();
    writeFileSync(torn, '{"pid": 4242');
    expect(readLockFile(torn)).toBe('{"pid": 4242');
  });

  it('removes idempotently — a missing file is not an error', () => {
    const path = tmpFile();
    expect(createLockFile(path, 'x')).toBe(true);
    removeLockFile(path);
    expect(readLockFile(path)).toBeUndefined();
    expect(() => removeLockFile(path)).not.toThrow(); // second call: still fine
  });
});

// Issue #361: the probe is POSIX-only — Windows cannot change the mode it
// reports, so a warn there would name a fix that does nothing.
describe('looseStateDirMode platform gate (issue #361)', () => {
  it('reports nothing on win32 even for a loose directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loose-'));
    roots.push(dir);
    chmodSync(dir, 0o755);

    expect(looseStateDirMode(dir)).toBe(0o755);
    const spy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32' as NodeJS.Platform);
    try {
      expect(looseStateDirMode(dir)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
