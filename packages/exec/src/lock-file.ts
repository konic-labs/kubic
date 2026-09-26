// Exclusive lock-file primitive (issue #118; §21–§22 session locking).
//
// Exec owns node:fs (I/O confinement, §9): the worker's session-store keeps
// the lock SEMANTICS (holder liveness, stale-steal rules, SessionLockError)
// and calls these three functions for the raw I/O. LOCAL FILESYSTEM ONLY:
// O_EXCL create is atomic on a local filesystem — no network/shared-disk
// (NFS/SMB) locking semantics are provided or claimed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * O_EXCL create — an atomic test-and-set. Returns `true` when the file was
 * written, `false` when the path already exists (the caller decides whether
 * the existing holder is stale). Any other error propagates: a lock that
 * cannot be written must never read as "acquired". The parent directory is
 * created eagerly so the lock can be written into a fresh session dir.
 */
export function createLockFile(path: string, payload: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload, { flag: 'wx' }); // O_EXCL
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * The raw lock contents, or `undefined` when the file is missing or
 * unreadable (a torn write is the caller's stale-candidate case). Reading
 * never throws: absence and damage are the caller's semantics to decide.
 */
export function readLockFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Best-effort remove (steal + release): a failed remove never throws. */
export function removeLockFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort — the caller's outcome must not be masked by the remove.
  }
}
