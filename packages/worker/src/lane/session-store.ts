// JSONL session store (issue #14, slice A; §21–§22). Sessions persist
// under <root>/<session-id>/ as Pi JSONL; attach reopens transcript,
// config, usage, and values. Kill mid-run → attach restores everything
// the harness wrote. Resume-from-checkpoint of in-flight ops and the
// CLI surface land in later slices.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
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

export function acquireSessionLock(
  sessionDir: string,
  sessionId: string,
): void {
  const lockPath = join(sessionDir, 'lock.json');
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' }); // O_EXCL: atomic test-and-set
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  // Stale handling exactly as the work-order sketch: a lock is refused
  // only while its holder process is alive AND the file is fresher than a
  // day. A gone holder alone is already stale (crash recovery must work
  // same-day); a day-old file is stale regardless (pid reuse). Torn
  // lock.json is a stale candidate either way.
  let holder: { pid?: unknown; startedAt?: unknown } = {};
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
    };
  } catch {
    // torn write: treat as stale candidate
  }
  const holderAlive =
    typeof holder.pid === 'number' &&
    (() => {
      try {
        process.kill(holder.pid as number, 0);
        return true;
      } catch {
        return false;
      }
    })();
  const staleByAge =
    typeof holder.startedAt === 'number' &&
    Date.now() - holder.startedAt > 24 * 60 * 60 * 1000;
  if (holderAlive && !staleByAge)
    throw new SessionLockError(sessionId, {
      pid: holder.pid as number,
      startedAt: holder.startedAt as number,
    });
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // lost the steal race: fall through
  }
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' });
    return;
  } catch {
    throw new SessionLockError(sessionId, { pid: -1, startedAt: 0 });
  }
}

export function createSession(
  store: SessionStore,
  cwd: string,
  context: Context,
  id?: string,
): Promise<Session> {
  return store.repo.create(id === undefined ? { cwd } : { cwd, id }, context);
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
  const listed = await store.repo.list(undefined, context);
  const metadata = listed.find((entry) => entry.id === sessionId);
  if (metadata === undefined) throw new SessionAttachError(sessionId);
  return store.repo.open(metadata, context);
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
