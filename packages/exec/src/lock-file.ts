// Exclusive lock-file primitive (issue #118; §21–§22 session locking).
//
// Exec owns node:fs (I/O confinement, §9): the worker's session-store keeps
// the lock SEMANTICS (holder liveness, stale-steal rules, SessionLockError)
// and calls these three functions for the raw I/O. LOCAL FILESYSTEM ONLY:
// O_EXCL create is atomic on a local filesystem — no network/shared-disk
// (NFS/SMB) locking semantics are provided or claimed.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
    // Issue #361: a session directory is Kubic's private state — 0700 for the
    // directory this call creates, 0600 for the lock file. Both are applied
    // at creation only; an existing path keeps its own mode (`tightenStateDir`
    // is what closes a loose one).
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, payload, { flag: 'wx', mode: 0o600 }); // O_EXCL
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Issue #361: the permission bits of a state directory when it is
 * group- or world-accessible — what `kubic doctor` warns about and what the
 * next open tightens. undefined when the path is missing, unreadable, or
 * already private, so a probe never invents a finding.
 */
export function looseStateDirMode(path: string): number | undefined {
  // Windows cannot change the mode it reports, so a warn there would name a
  // fix that does nothing: the probe is POSIX-only, like the modes themselves.
  if (process.platform === 'win32') return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) !== 0 ? mode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Issue #361: close a loose state directory (0700) — called when a state
 * store is opened, so an existing group- or world-readable
 * `~/.kubic/sessions` (or a journal directory) stops being readable by other
 * local users. Returns true when it tightened something. Best-effort: a
 * directory this process cannot chmod stays as it is, and `kubic doctor`
 * keeps naming it.
 */
export function tightenStateDir(path: string): boolean {
  if (looseStateDirMode(path) === undefined) return false;
  try {
    chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
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
