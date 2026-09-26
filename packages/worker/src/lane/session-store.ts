// JSONL session store (issue #14, slice A; §21–§22). Sessions persist
// under <root>/<session-id>/ as Pi JSONL; attach reopens transcript,
// config, usage, and values. Kill mid-run → attach restores everything
// the harness wrote. Resume-from-checkpoint of in-flight ops and the
// CLI surface land in later slices.

import { join } from 'node:path';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  createLockFile,
  readLockFile,
  removeLockFile,
} from '../../../exec/src/lock-file.js';
import {
  type Context,
  JsonlSessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bridgeToPiFileSystem } from './session-fs.js';

export interface SessionStore {
  repo: JsonlSessionRepo;
  root: string;
}

export function openSessionStore(
  root: string,
  bridge: FileBridge,
): SessionStore {
  return {
    repo: new JsonlSessionRepo({
      fileSystem: bridgeToPiFileSystem(bridge),
      sessionsRoot: root,
    }),
    root,
  };
}

// Session locking (issue #118; §21–§22): one live attachment per session.
// The lock file is <sessions-root>/<id>/lock.json — `{pid, startedAt}` of
// the attaching process. LOCAL FILESYSTEM ONLY: O_EXCL create is atomic on
// a local fs (and on volumes that honor it), but no network/shared-disk
// locking semantics are claimed — see docs/packages/worker.md.
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
// stale-candidate case, never a crash).
function readLockHolder(lockPath: string): {
  pid?: number;
  startedAt?: number;
} {
  const raw = readLockFile(lockPath);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (parsed === null || typeof parsed !== 'object') return {};
    return {
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.startedAt === 'number'
        ? { startedAt: parsed.startedAt }
        : {}),
    };
  } catch {
    // torn write: treat as stale candidate
    return {};
  }
}

// process.kill(pid, 0) is the liveness probe — signal 0 performs the
// permission and existence checks without delivering a signal. There is no
// `process.exists` and reading /proc is not portable; this is the standard
// probe (and it is what tests stub to stay hermetic).
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSessionLock(
  sessionDir: string,
  sessionId: string,
): void {
  const lockPath = join(sessionDir, 'lock.json');
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  // O_EXCL test-and-set via the exec seam (I/O confinement, §9; the
  // primitive creates the session dir eagerly so the lock can land there).
  if (createLockFile(lockPath, payload)) return;
  // Stale handling exactly as the work-order sketch: a lock is refused
  // only while its holder process is alive AND the file is fresher than a
  // day. A gone holder alone is already stale (crash recovery must work
  // same-day); a day-old file is stale regardless (pid reuse). Torn
  // lock.json is a stale candidate either way.
  const holder = readLockHolder(lockPath);
  const holderAlive = holder.pid !== undefined && pidIsAlive(holder.pid);
  const staleByAge =
    holder.startedAt !== undefined &&
    Date.now() - holder.startedAt > 24 * 60 * 60 * 1000;
  if (holderAlive && !staleByAge)
    throw new SessionLockError(sessionId, {
      pid: holder.pid as number,
      startedAt: holder.startedAt as number,
    });
  removeLockFile(lockPath);
  if (createLockFile(lockPath, payload)) return;
  throw new SessionLockError(sessionId, { pid: -1, startedAt: 0 });
}

// Read-only liveness view for consumers that must never pull state out
// from under a live attachment (issue #119: `kubic sessions prune`).
// Stronger than the steal rule above on purpose: deletion is
// unrecoverable, so ANY live holder pid protects the session regardless
// of the lock's age (a reused pid can cost at most a skipped prune), while
// a dead holder — or a torn/absent payload — never protects. LOCAL
// FILESYSTEM ONLY, like every read here: pid liveness is this machine's
// process table, never another host's.
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

export function releaseSessionLock(sessionDir: string): void {
  removeLockFile(join(sessionDir, 'lock.json'));
}

// Close releases the lock (issue #118): every consumer's `session.close`
// path gets the release for free, so no caller can leak a lock by
// forgetting an unlock step.
function withLockRelease(session: Session, sessionDir: string): Session {
  const close = session.close.bind(session);
  session.close = async (context: Context): Promise<void> => {
    try {
      await close(context);
    } finally {
      releaseSessionLock(sessionDir);
    }
  };
  return session;
}

export async function createSession(
  store: SessionStore,
  cwd: string,
  context: Context,
  id?: string,
): Promise<Session> {
  const session = await store.repo.create(
    id === undefined ? { cwd } : { cwd, id },
    context,
  );
  // Acquired once the session exists (issue #118). The lock lives in the
  // session's own state dir <root>/<id> — where the journal, spans, and
  // approval posture live too — created eagerly by the lock primitive
  // itself (the primitive's O_EXCL write makes the dir its parent).
  const sessionDir = join(store.root, session.metadata.id);
  acquireSessionLock(sessionDir, session.metadata.id);
  return withLockRelease(session, sessionDir);
}

export class SessionAttachError extends Error {
  constructor(sessionId: string) {
    super(`unknown session: ${sessionId}`);
    this.name = 'SessionAttachError';
  }
}

export async function attachSession(
  store: SessionStore,
  sessionId: string,
  context: Context,
): Promise<Session> {
  const sessionDir = join(store.root, sessionId);
  // The listing only resolves the id (it reads no transcript); the lock is
  // held before the session itself is read or written (issue #118), so no
  // reader ever observes a session another live attachment is writing.
  const listed = await store.repo.list(undefined, context);
  const metadata = listed.find((entry) => entry.id === sessionId);
  if (metadata === undefined) throw new SessionAttachError(sessionId);
  acquireSessionLock(sessionDir, sessionId);
  try {
    return withLockRelease(
      await store.repo.open(metadata, context),
      sessionDir,
    );
  } catch (error) {
    // The lock above is ours; an attach that fails must not strand it.
    releaseSessionLock(sessionDir);
    throw error;
  }
}

export function listSessions(
  store: SessionStore,
  context: Context,
): Promise<Array<{ id: string; cwd?: string }>> {
  return store.repo
    .list(undefined, context)
    .then((entries) =>
      entries.map((entry) => ({ id: entry.id, cwd: entry.cwd })),
    );
}

// Repo-level overlap probe (issue #118; §42.5 blind spot): the ids of
// every session recorded against `workspace`. Two different sessions on
// one workspace are LEGAL (warning only, never a block) — but each run's
// end-of-run sweep attributes the other's in-flight changes as
// unattributed, non-reversible entries, and this probe is how that
// limitation is surfaced (the sweep debug line and the `kubic doctor`
// note). Local-store view only: no cross-host truth is claimed.
export function sessionsTouchingWorkspace(
  store: SessionStore,
  workspace: string,
  context: Context,
): Promise<string[]> {
  return store.repo
    .list(undefined, context)
    .then((entries) =>
      entries
        .filter((entry) => entry.cwd === workspace)
        .map((entry) => entry.id),
    );
}
