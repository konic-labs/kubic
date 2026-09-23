// JSONL session store (issue #14, slice A; §21–§22). Sessions persist
// under <root>/<session-id>/ as Pi JSONL; attach reopens transcript,
// config, usage, and values. Kill mid-run → attach restores everything
// the harness wrote. Resume-from-checkpoint of in-flight ops and the
// CLI surface land in later slices.

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
