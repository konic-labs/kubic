// Exclusive lock-file primitive (issue #118; §21–§22 session locking).
//
// Exec owns node:fs (I/O confinement, §9): the worker's session-store keeps
// the lock SEMANTICS (holder liveness, stale-steal rules, SessionLockError)
// and calls these three functions for the raw I/O. LOCAL FILESYSTEM ONLY:
// O_EXCL create is atomic on a local filesystem — no network/shared-disk
// (NFS/SMB) locking semantics are provided or claimed.

import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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

// The /proc field carrying a process's start time: `starttime` is field 22
// of `/proc/<pid>/stat`, and stripping `pid (comm) ` leaves field 3 at
// index 0, so starttime sits at index 19. `comm` may hold spaces and
// parens, hence the last-`)` split rather than a fixed offset.
const PROC_STAT_STARTTIME_INDEX = 19;

// USER_HZ on every supported Linux target: the starttime tick in
// milliseconds. The value only needs to be self-consistent — the holder
// records through this function and the verifier recomputes through it —
// so even a wrong HZ still compares equal for the same process.
const LINUX_CLOCK_TICK_MS = 10;

/**
 * Issue #145: the pure half of the start-time reader — `starttime` ticks
 * from a `/proc/<pid>/stat` text with a `/proc/stat` boot time. Exported
 * so the field arithmetic is pinned by a fixture test on every platform
 * (the file reads themselves only exist on Linux).
 */
export function procStartTimeFromStat(
  stat: string,
  bootTimeMs: number,
): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  const ticks = Number(
    stat.slice(close + 2).split(' ')[PROC_STAT_STARTTIME_INDEX],
  );
  if (!Number.isFinite(ticks) || ticks < 0) return undefined;
  return bootTimeMs + ticks * LINUX_CLOCK_TICK_MS;
}

function readProcStartTimeMs(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const bootMs = readProcBootTimeMs();
  if (bootMs === undefined) return undefined;
  return procStartTimeFromStat(stat, bootMs);
}

function readProcBootTimeMs(): number | undefined {
  let stat: string;
  try {
    stat = readFileSync('/proc/stat', 'utf8');
  } catch {
    return undefined;
  }
  for (const line of stat.split('\n')) {
    if (!line.startsWith('btime ')) continue;
    const seconds = Number(line.slice('btime '.length).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return seconds * 1000;
  }
  return undefined;
}

/**
 * Issue #145: when `pid` started, as epoch milliseconds — the pid-reuse
 * guard behind the session lock's stale rule. Linux-only (`/proc` is the
 * only source that needs no spawn and no privileges); `undefined` on any
 * other platform and for any unreadable pid, so the caller falls back to
 * the pid probe. Never throws. A reboot moves every start time, so this
 * also catches reuse across boots.
 */
export function processStartTimeOf(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'linux') return undefined;
  return readProcStartTimeMs(pid);
}

/**
 * Issue #145: land `payload` at `lockPath` atomically — the stale-takeover
 * claim. The payload is written to a unique temp file in the same directory
 * (same filesystem, a link requirement) and hard-linked into place: the
 * link is the test-and-set, so exactly one racer's claim lands per
 * generation and every loser sees EEXIST. Returns `true` when this call's
 * payload landed, `false` when an occupant is already there (left
 * untouched). The temp name is dropped either way, so no litter survives.
 * Issue #424: a temp-name collision (EEXIST on the exclusive create —
 * vanishingly rare, but raw-thrown before) retries under a fresh name
 * instead of throwing. LOCAL FILESYSTEM ONLY, like every lock read here.
 */
export function claimLockLink(lockPath: string, payload: string): boolean {
  const dir = dirname(lockPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = join(
      dir,
      `.lock.tmp.${process.pid}.${stamp}.${attempt}.${rand}`,
    );
    try {
      writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // Our own temp name is taken: retry under a fresh one. Anything
      // else is a real I/O failure and still throws.
      if (
        (error as { code?: string } | null)?.code === 'EEXIST' &&
        attempt < 2
      )
        continue;
      throw error;
    }
    const dropTemp = (): void => {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort — the claim's outcome is what the caller reports.
      }
    };
    try {
      linkSync(tmp, lockPath);
    } catch (error) {
      dropTemp();
      if ((error as { code?: string } | null)?.code === 'EEXIST') return false;
      throw error;
    }
    // The link and the temp are one inode now; dropping the temp name leaves
    // the lock as its only name.
    dropTemp();
    return true;
  }
  // Unreachable: the loop either lands, loses, throws, or retries.
  throw new Error('claimLockLink: temp-name retries exhausted');
}
