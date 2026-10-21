// Exclusive lock-file primitive (session locking).
//
// Exec owns node:fs (I/O confinement): the agent's session-store keeps
// the lock SEMANTICS (holder liveness, stale-steal rules, SessionLockError)
// and calls these three functions for the raw I/O. LOCAL FILESYSTEM ONLY:
// O_EXCL create is atomic on a local filesystem — no network/shared-disk
// (NFS/SMB) locking semantics are provided or claimed.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
    // A session directory is Kubic's private state — 0700 for the
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
 * The permission bits of a state directory when it is
 * group- or world-accessible — what `kubic doctor` warns about and what the
 * next open tightens. undefined when the path is missing, unreadable, or
 * already private, so a probe never invents a finding.
 * @internal
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
 * Close a loose state directory (0700) — called when a state
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

interface LooseStateEntry {
  readonly path: string;
  readonly mode: number;
  /** 0o700 for a directory, 0o600 for a file. */
  readonly expected: number;
}

export interface StateModeScan {
  /** The first loose entries found, in walk order. */
  readonly loose: readonly LooseStateEntry[];
  /** Every loose entry found. */
  readonly count: number;
  /** Entries examined. */
  readonly checked: number;
  /** The walk stopped at its bound before it saw everything. */
  readonly truncated: boolean;
}

/**
 * The state other local users can reach: every directory should be 0700 and
 * every file 0600. `paths` are checked alone (a missing one is skipped),
 * `trees` are walked — newest name first, so the newest sessions are seen
 * before the bound — and a symlink is never followed. The walk stops after
 * `limit` entries and keeps the first `keep` findings. undefined on Windows,
 * whose modes mean nothing (the same POSIX-only rule as looseStateDirMode).
 */
export function scanStateModes(
  paths: readonly string[],
  trees: readonly string[],
  { limit = 4096, keep = 3 }: { limit?: number; keep?: number } = {},
): StateModeScan | undefined {
  if (process.platform === 'win32') return undefined;
  const loose: LooseStateEntry[] = [];
  let count = 0;
  let checked = 0;
  // One entry: false when the bound is reached; a directory of a tree is
  // queued for its children.
  const queue: string[] = [];
  const seen = new Set<string>();
  const visit = (path: string, walk: boolean): boolean => {
    if (seen.has(path)) return true;
    if (checked >= limit) return false;
    seen.add(path);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      return true;
    }
    checked += 1;
    if (info.isSymbolicLink()) return true;
    const expected = info.isDirectory() ? 0o700 : 0o600;
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      count += 1;
      if (loose.length < keep) loose.push({ path, mode, expected });
    }
    if (walk && info.isDirectory()) queue.push(path);
    return true;
  };
  let truncated = false;
  for (const path of paths) {
    if (!visit(path, false)) truncated = true;
  }
  for (const tree of trees) {
    if (!visit(tree, true)) truncated = true;
  }
  while (!truncated && queue.length > 0) {
    const dir = queue.shift() as string;
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!visit(join(dir, name), true)) {
        truncated = true;
        break;
      }
    }
  }
  return { loose, count, checked, truncated };
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
 * The pure half of the start-time reader — `starttime` ticks
 * from a `/proc/<pid>/stat` text with a `/proc/stat` boot time. Exported
 * so the field arithmetic is pinned by a fixture test on every platform
 * (the file reads themselves only exist on Linux).
 */
/** @internal */
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

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * The pure half of the macOS start-time reader: `ps -o lstart=` output
 * (`Wed Oct 21 06:04:15 2026`, printed in UTC) as epoch milliseconds.
 * @internal
 */
export function startTimeFromLstart(text: string): number | undefined {
  const match =
    /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
      text,
    );
  if (match === null) return undefined;
  const month = MONTHS.indexOf(match[1] ?? '');
  if (month === -1) return undefined;
  return Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

// macOS has no /proc: `ps` names a process's start time to the second. The
// C locale and UTC make every process read the same instant the same way,
// whatever the user's own locale and time zone. A dead pid, a missing `ps`
// or a slow one reads as unknown.
function readPsStartTimeMs(pid: number): number | undefined {
  try {
    return startTimeFromLstart(
      execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/bin:/usr/bin' },
      }),
    );
  } catch {
    return undefined;
  }
}

// This process's own start, read once: a lock claim names it on every
// acquire (each journal append), and a spawn per claim would be costly.
let ownStartTime: { readonly value: number | undefined } | undefined;

/**
 * When `pid` started, as epoch milliseconds — the pid-reuse guard behind
 * the session and file locks' stale rules. Linux reads `/proc` (no spawn,
 * no privileges); macOS asks `ps`, once per process for its own pid and on
 * the contention path for another one. `undefined` on any other platform and
 * for any unreadable pid, so the caller falls back to the pid probe. Never
 * throws. A reboot moves every start time, so this also catches reuse
 * across boots.
 */
export function processStartTimeOf(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') return readProcStartTimeMs(pid);
  if (process.platform !== 'darwin') return undefined;
  if (pid !== process.pid) return readPsStartTimeMs(pid);
  ownStartTime ??= { value: readPsStartTimeMs(pid) };
  return ownStartTime.value;
}

/**
 * Land `payload` at `lockPath` atomically — the stale-takeover
 * claim. The payload is written to a unique temp file in the same directory
 * (same filesystem, a link requirement) and hard-linked into place: the
 * link is the test-and-set, so exactly one racer's claim lands per
 * generation and every loser sees EEXIST. Returns `true` when this call's
 * payload landed, `false` when an occupant is already there (left
 * untouched). The temp name is dropped either way, so no litter survives.
 * A temp-name collision (EEXIST on the exclusive create, vanishingly rare)
 * retries under a fresh name instead of throwing. LOCAL FILESYSTEM ONLY, like every lock read here.
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
      // Our own temp name is taken: retry under a fresh one, three names
      // at most (the attempt index is part of the name, so a collision
      // needs a leftover with this pid, millisecond and random stamp).
      // Anything else is a real I/O failure (ENOSPC, EIO): the half-written
      // temp is dropped, and the error still throws.
      if ((error as { code?: string } | null)?.code === 'EEXIST') {
        if (attempt < 2) continue;
        throw error;
      }
      rmSync(tmp, { force: true });
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

// A lock's holder, as a waiter reads it: whether its claim names a holder
// that is gone. A claim names its process (pid and, where the platform tells
// it, the process start time, which unmasks a reused pid). Residue that names
// no holder this way — an older build's bare pid, which still names a pid,
// or unreadable bytes — counts as gone only past `staleMs`, or when its pid
// is dead.
function holderGone(
  lockPath: string,
  observed: string,
  staleMs: number,
): boolean {
  let holder: { pid?: unknown; startedAt?: unknown } | undefined;
  if (/^\d+$/.test(observed.trim())) {
    holder = { pid: Number(observed.trim()) };
  } else {
    try {
      const parsed: unknown = JSON.parse(observed);
      holder =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { pid?: unknown; startedAt?: unknown })
          : undefined;
    } catch {
      holder = undefined;
    }
  }
  const pid = typeof holder?.pid === 'number' ? holder.pid : undefined;
  if (pid === undefined) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  if (!processAlive(pid)) return true;
  const startedAt = holder?.startedAt;
  if (typeof startedAt !== 'number') return false;
  const now = processStartTimeOf(pid);
  return now !== undefined && now !== startedAt;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists, owned by another user.
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
}

function lockPayload(): string {
  return JSON.stringify({
    pid: process.pid,
    startedAt: processStartTimeOf(process.pid) ?? null,
    nonce: `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`,
  });
}

// Take a gone holder's lock away, under the steal guard: while the guard is
// held, the lock can change only by its own holder's release, which a gone
// holder never makes, so the occupant judged gone is the one removed. Returns
// true when the lock was cleared (or vanished) and a claim should be tried
// again. A guard whose own holder is gone is cleared too, so a waiter that
// died mid-steal cannot wedge the lock.
function stealGoneHolder(lockPath: string, staleMs: number): boolean {
  const guard = `${lockPath}.steal`;
  const guardPayload = lockPayload();
  if (!claimLockLink(guard, guardPayload)) {
    const occupant = readLockFile(guard);
    if (occupant !== undefined && holderGone(guard, occupant, staleMs)) {
      removeLockFile(guard);
    }
    return false;
  }
  try {
    const observed = readLockFile(lockPath);
    if (observed === undefined) return true;
    if (!holderGone(lockPath, observed, staleMs)) return false;
    removeLockFile(lockPath);
    return true;
  } finally {
    if (readLockFile(guard) === guardPayload) removeLockFile(guard);
  }
}

/**
 * Run `run` while holding the lock at `lockPath`: the seam for a mutation
 * that must not interleave with another process's — the journal's append,
 * retention rewrite and blob sweep, and the trust store's update. A claim
 * lands atomically with its holder's identity (pid, process start time, a
 * nonce). A waiter takes the lock away only when its holder is gone; a live
 * holder is waited for up to `waitMs`, however long it runs, before the
 * caller gets a named timeout. The release removes only this claim's own
 * lock, never one that has since changed hands. LOCAL FILESYSTEM ONLY, like
 * every lock here.
 */
export function withFileLocked<T>(
  lockPath: string,
  run: () => T,
  options: { staleMs?: number; waitMs?: number } = {},
): T {
  const staleMs = options.staleMs ?? 10_000;
  const deadline = Date.now() + (options.waitMs ?? 5_000);
  const payload = lockPayload();
  while (!claimLockLink(lockPath, payload)) {
    if (stealGoneHolder(lockPath, staleMs)) continue;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockPath}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return run();
  } finally {
    if (readLockFile(lockPath) === payload) removeLockFile(lockPath);
  }
}
