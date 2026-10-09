// The session lock (`lock.json`): one process owns a session's storage at a
// time. pi-durable has no cross-process locking, so this lock is the only guard.

import { dirname, join } from 'node:path';
import {
  claimLockLink,
  createLockFile,
  processStartTimeOf,
  readLockFile,
  removeLockFile,
  tightenStateDir,
} from '@kubic/exec/lock-file';

// Session locking: one live attachment per session. The lock file is
// <sessions-root>/<id>/lock.json — `{pid, startedAt, procStart?, nonce?}` of
// the attaching process (`startedAt` is when the lock was taken, `procStart`
// the holder process's own start time for the pid-reuse guard, `nonce` the
// per-attempt unique that makes the post-write verification exact). It wraps
// EVERY storage open: pi-durable owns a storage exclusively and does no
// cross-process locking, so the Kubic lock is the only guard against two
// processes appending to one session. LOCAL FILESYSTEM ONLY: O_EXCL create and
// hard links are atomic on a local fs (and on volumes that honor them), but no
// network/shared-disk locking semantics are claimed — see
// docs/packages/agent.md.
export class SessionLockError extends Error {
  constructor(sessionId: string, holder: { pid: number; startedAt: number }) {
    // Totality: a partially-written lock must refuse with the named error,
    // never an Invalid Date crash.
    const since =
      typeof holder.startedAt === 'number' && Number.isFinite(holder.startedAt)
        ? new Date(holder.startedAt).toISOString()
        : 'unknown start time';
    super(
      `session '${sessionId}' is attached by pid ${holder.pid} (since ${since}) — ` +
        `refusing a second live attachment`,
    );
    this.name = 'SessionLockError';
  }
}

// The lock file's holder, as far as it can be read: a torn write or a
// non-object payload yields what is missing and nothing more (the caller's
// stale-candidate case, never a crash). Unknown keys (`nonce`, …) are
// ignored; legacy locks simply carry no `procStart`.
interface LockHolder {
  pid?: number;
  startedAt?: number;
  procStart?: number;
  nonce?: string;
}

function parseLockHolder(raw: string | undefined): LockHolder {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      startedAt?: unknown;
      procStart?: unknown;
      nonce?: unknown;
    };
    if (parsed === null || typeof parsed !== 'object') return {};
    return {
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.startedAt === 'number'
        ? { startedAt: parsed.startedAt }
        : {}),
      ...(typeof parsed.procStart === 'number'
        ? { procStart: parsed.procStart }
        : {}),
      // The nonce survives the parse so release can prove
      // ownership — it is the only per-attempt unique in the payload.
      ...(typeof parsed.nonce === 'string' ? { nonce: parsed.nonce } : {}),
    };
  } catch {
    // torn write: treat as stale candidate
    return {};
  }
}

function readLockHolder(lockPath: string): LockHolder {
  return parseLockHolder(readLockFile(lockPath));
}

// process.kill(pid, 0) is the liveness probe — signal 0 performs the
// permission and existence checks without delivering a signal. There is no
// `process.exists` and reading /proc is not portable; this is the standard
// probe (and it is what tests stub to stay hermetic).
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another
    // uid — alive, not stale. ESRCH (and any other failure) reads as not
    // alive; the start-time reuse guard above is what doubts toward the
    // holder, not the pid probe.
    const code = (error as { code?: string } | null)?.code;
    return code === 'EPERM';
  }
}

// How far the recorded process start may drift from the pid's actual
// start and still name the same process. Both sides compute through the
// same reader, so a live holder compares exactly equal — the tolerance is
// belt-and-braces for tick rounding, not a window a reused pid can hide
// in (reuse moves the start by the gap between the two processes).
const PROC_START_TOLERANCE_MS = 1000;

// Holder liveness: the pid probe plus the start-time check
// against pid reuse. A live pid number is not necessarily the holder — the
// recorded process start must still match the pid's actual start. There is
// NO age rule: a 48h-old lock with a live, matching holder is a long TUI
// session, never stale. A dead holder is stale immediately (crash recovery
// works same-day); a torn payload names nobody and is a stale candidate.
// Locks without a recorded start (legacy shape, or a platform without a
// start-time source) and pids whose start cannot be read fall back to the
// pid probe: stealing is the destructive arm, so doubt protects the holder.
function holderIsLive(holder: LockHolder): boolean {
  if (holder.pid === undefined || !pidIsAlive(holder.pid)) return false;
  if (holder.procStart === undefined) return true;
  const actual = processStartTimeOf(holder.pid);
  if (actual === undefined) return true;
  return Math.abs(actual - holder.procStart) <= PROC_START_TOLERANCE_MS;
}

function lockErrorHolder(holder: LockHolder): {
  pid: number;
  startedAt: number;
} {
  return {
    pid: holder.pid ?? -1,
    startedAt: holder.startedAt ?? 0,
  };
}

// Stale takeover: temp lock + link claim, re-read and verify
// the owner. Each generation is arbitrated by the link — exactly one racer
// lands, every loser sees EEXIST — and the clear only ever removes the
// stale occupant this attempt judged: bytes that changed under us mean a
// rival acted, so re-evaluate instead of deleting a lock that may now be
// live. A live occupant throws naming it; surviving the bounded retries
// without landing throws naming nobody.
function stealSessionLock(
  lockPath: string,
  sessionId: string,
  payload: string,
): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = readLockFile(lockPath);
    const holder = parseLockHolder(observed);
    if (holderIsLive(holder))
      throw new SessionLockError(sessionId, lockErrorHolder(holder));
    // Conditional clear: only remove the occupant judged stale above.
    // Unconditional compare: an absent read licenses
    // nothing — `undefined` compares correctly, so a live lock that lands
    // after an absent read is re-evaluated, never removed.
    if (readLockFile(lockPath) !== observed) continue;
    removeLockFile(lockPath);
    if (
      claimLockLink(lockPath, payload) &&
      readLockFile(lockPath) === payload
    ) {
      return;
    }
    // Lost the claim or the verify: loop re-reads, and a live winner
    // throws above.
  }
  throw new SessionLockError(sessionId, { pid: -1, startedAt: 0 });
}

export function acquireSessionLock(
  sessionDir: string,
  sessionId: string,
): string {
  // A session directory is private state; an existing loose one
  // (created before this, or by hand) is closed on the way in — and so is the
  // sessions root, which is what `kubic doctor` reports and what the docs
  // promise the next open tightens. The root holds nothing but these session
  // directories, so 0700 is its correct posture.
  tightenStateDir(sessionDir);
  tightenStateDir(dirname(sessionDir));
  const lockPath = join(sessionDir, 'lock.json');
  const ownStart = processStartTimeOf(process.pid);
  // The nonce makes the post-write verification exact: only these bytes
  // read as "acquired by this attempt". Returned so the owner's release
  // can prove it — a stale handle's old nonce never matches
  // a re-acquired lock.
  const nonce = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    ...(ownStart === undefined ? {} : { procStart: ownStart }),
    nonce,
  });
  // O_EXCL test-and-set via the exec seam (I/O confinement, the
  // primitive creates the session dir eagerly so the lock can land there).
  // The verify closes the fresh path against a stealer that observed a
  // stale lock before our create: bytes that are not ours fall through to
  // the steal path, which re-evaluates the live occupant.
  if (createLockFile(lockPath, payload)) {
    if (readLockFile(lockPath) === payload) return nonce;
  } else {
    const holder = readLockHolder(lockPath);
    if (holderIsLive(holder))
      throw new SessionLockError(sessionId, lockErrorHolder(holder));
  }
  stealSessionLock(lockPath, sessionId, payload);
  return nonce;
}

// Read-only liveness view for consumers that must never pull state out
// from under a live attachment (`kubic sessions prune`).
// Pid-only on purpose, and deliberately stronger than the steal rule:
// deletion is unrecoverable, so ANY live holder pid protects the session
// — prune never applies the start-time reuse check, and a reused pid costs
// at most a skipped prune — while a dead holder, or a torn/absent payload,
// never protects. LOCAL FILESYSTEM ONLY, like every read here: pid
// liveness is this machine's process table, never another host's.
export function sessionLockIsLive(
  sessionDir: string,
): { pid: number; startedAt?: number } | undefined {
  const holder = readLockHolder(join(sessionDir, 'lock.json'));
  if (holder.pid === undefined || !pidIsAlive(holder.pid)) return undefined;
  return {
    pid: holder.pid,
    ...(holder.startedAt === undefined ? {} : { startedAt: holder.startedAt }),
  };
}

export function releaseSessionLock(sessionDir: string, nonce?: string): void {
  const lockPath = join(sessionDir, 'lock.json');
  const holder = readLockHolder(lockPath);
  // Owned-release only: a lock naming
  // another process is left alone. A nonced lock is ours exactly when it
  // carries the releasing handle's nonce — the pid alone is not enough,
  // because the same process can release, re-acquire, and then run a
  // stale handle's release over its own live lock. A caller with no nonce
  // never owned a nonced lock, and a torn payload is never provably ours
  // (it stays a stale candidate for the next acquire). Legacy locks with
  // no nonce keep the pid rule; missing stays the idempotent no-op.
  if (holder.nonce !== undefined) {
    if (nonce === undefined || holder.nonce !== nonce) return;
  } else if (holder.pid !== process.pid) {
    return;
  }
  removeLockFile(lockPath);
}
