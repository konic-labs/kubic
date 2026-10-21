// Creating, attaching and listing sessions. A handle carries the storage the
// lane runs on and the lock that guards it.
import type { RunMode } from '../../permissions.js';
import type { Context, Storage } from '../../pi-boundary.js';
import {
  createSession as createSessionKernel,
  JsonlStorage,
  uuidv7,
} from '../../pi-boundary.js';
import { bridgeToPiFileSystem } from '../session-fs.js';
import { isSessionId, SessionIdError } from './ids.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import type {
  KubicSessionMeta,
  SessionListEntry,
  SessionStore,
} from './meta.js';
import {
  headerPathOf,
  isSessionShaped,
  KubicSessionDoc,
  listDirOrNothing,
  readSessionHeader,
  readSessionMetadata,
  sessionDirOf,
  storagePathOf,
  writeSessionHeader,
} from './meta.js';

// One attached session: the open storage, the session's metadata, and the
// release that gives both back.
export interface SessionHandle {
  readonly id: string;
  /** `<sessions-root>/<id>`: the storage directory and the session's state dir. */
  readonly dir: string;
  /**
   * The pi-durable storage for this session, open for the handle's lifetime.
   * The Kubic session lock is held for that same lifetime: a harness opened
   * over this storage is the only owner, and a second attach is refused.
   *
   * Ownership stays with the handle: this property is for READS (see
   * `readSessionMetadata`). A harness is booted from `adopt()`.
   */
  readonly storage: Storage;
  readonly meta: KubicSessionMeta;
  /**
   * Hand the storage to a durable Harness:
   * `Harness.open(handle.adopt(), …)`. The handle stops owning the storage,
   * so `release()` gives the lock back without closing a storage a live
   * harness is using — the harness closes it. Returns the same object
   * `storage` exposes.
   */
  adopt(): Storage;
  /**
   * Give the session back: always release the lock, and close the storage
   * only while no harness adopted it (`adopt()`). Both are idempotent, so a
   * session that was never booted and one whose harness already closed it
   * release the same way. Call after the harness is closed.
   */
  release(context: Context): Promise<void>;
}

export async function openSessionStorage(
  store: SessionStore,
  sessionDir: string,
  context: Context,
): Promise<Storage> {
  // The portable core over the exec bridge, never the `/node` entry point:
  // session bytes keep crossing the I/O seam, where the secret scrubbing
  // and the file modes live (see session-fs.ts). fsync stays off — the
  // file header explains why.
  return JsonlStorage.open(
    sessionDir,
    bridgeToPiFileSystem(store.bridge),
    context,
    { fsync: false },
  );
}

// Release gives the lock back, and gives the storage back too while the handle
// still owns it: every consumer's release path gets the
// unlock for free, so no caller can leak a lock by forgetting an unlock step.
// A storage a harness adopted is never closed from under it — the harness owns
// it and closes it — and every step is idempotent.
function handleFor(
  storage: Storage,
  sessionDir: string,
  id: string,
  meta: KubicSessionMeta,
  // The acquire's nonce: the handle's release proves ownership with it instead
  // of the pid alone.
  nonce: string,
): SessionHandle {
  let adopted = false;
  return {
    id,
    dir: sessionDir,
    storage,
    meta,
    adopt: (): Storage => {
      adopted = true;
      return storage;
    },
    release: async (context: Context): Promise<void> => {
      try {
        if (!adopted) await storage.close(context);
      } finally {
        releaseSessionLock(sessionDir, nonce);
      }
    },
  };
}

export async function createSession(
  store: SessionStore,
  opts: {
    id?: string;
    cwd: string;
    workspace?: string;
    // The run's mode, recorded in the creating commit.
    mode?: RunMode;
  },
  context: Context,
): Promise<SessionHandle> {
  const sessionId = opts.id ?? uuidv7();
  if (!isSessionId(sessionId)) throw new SessionIdError(sessionId);
  const sessionDir = sessionDirOf(store, sessionId);
  // Refusals before the lock: a session that already exists is never
  // re-created over.
  if (store.bridge.exists(storagePathOf(sessionDir)))
    throw new Error(`Session already exists: ${sessionId}`);
  // The lock is acquired FIRST: it is the only guard around a
  // storage open, so it must be held before the storage exists, not after.
  // The lock primitive creates the session dir eagerly, which is also the
  // storage's directory.
  const createNonce = acquireSessionLock(sessionDir, sessionId);
  try {
    const meta: KubicSessionMeta = {
      cwd: opts.cwd,
      createdAt: new Date().toISOString(),
      ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    };
    const storage = await openSessionStorage(store, sessionDir, context);
    // The creating commit: the session's metadata is written with the session
    // itself. A plain Session kernel does it — the harness (and its model
    // layer) belongs to the caller, and hand-built storage records would
    // reimplement the kernel's record semantics.
    const kernel = createSessionKernel(storage);
    try {
      await kernel.commit(async (tx) => {
        const doc = await tx.doc(KubicSessionDoc);
        doc.id = sessionId;
        doc.cwd = meta.cwd;
        doc.createdAt = meta.createdAt;
        if (meta.workspace !== undefined) doc.workspace = meta.workspace;
        if (meta.mode !== undefined) doc.mode = meta.mode;
      }, context);
    } finally {
      // The kernel owns the storage it was opened over: closing it closes the
      // storage, so the handle gets its own open of the same directory (two
      // committed lines at this point — one recovery pass).
      await kernel.close(context);
    }
    writeSessionHeader(store, sessionDir, sessionId, meta);
    return handleFor(
      await openSessionStorage(store, sessionDir, context),
      sessionDir,
      sessionId,
      meta,
      createNonce,
    );
  } catch (error) {
    // A create that fails must not strand its lock, and must not leave a
    // half-made storage behind: the guard above would then refuse every
    // retry as `Session already exists`. The files this call created are
    // removed (the directory and anything predating the call stay); any
    // orphaned sidecar is dropped by the next open's recovery.
    releaseSessionLock(sessionDir, createNonce);
    for (const path of [storagePathOf(sessionDir), headerPathOf(sessionDir)]) {
      try {
        // FileBridge.remove takes positional flags, not an options object.
        store.bridge.remove(path, false, true);
      } catch {
        // Best-effort: the failure that got us here is the one to report.
      }
    }
    throw error;
  }
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
): Promise<SessionHandle> {
  // Containment before any path join: the id becomes a directory name.
  if (!isSessionId(sessionId)) throw new SessionAttachError(sessionId);
  const sessionDir = sessionDirOf(store, sessionId);
  // Nothing to open: the store has never seen this id. Checked before the
  // lock so an unknown id never creates a session directory.
  if (!store.bridge.exists(storagePathOf(sessionDir)))
    throw new SessionAttachError(sessionId);
  // The lock is held before the storage is opened: no
  // reader ever observes a session another live attachment is writing, and no
  // second process ever opens the same pi-durable storage.
  const attachNonce = acquireSessionLock(sessionDir, sessionId);
  let storage: Storage | undefined;
  try {
    storage = await openSessionStorage(store, sessionDir, context);
    // The document is the session's own record; the listing header is the
    // projection. Read the truth, then re-sync the projection when it drifted
    // (a session created before a field existed, a header torn by a crash).
    const fromDocument = await readSessionMetadata(storage, context);
    const meta = fromDocument ?? readSessionHeader(store, sessionDir);
    if (meta === undefined) throw new SessionAttachError(sessionId);
    if (fromDocument !== undefined) {
      const header = readSessionHeader(store, sessionDir);
      if (
        header === undefined ||
        header.cwd !== meta.cwd ||
        header.createdAt !== meta.createdAt ||
        header.workspace !== meta.workspace
      ) {
        writeSessionHeader(store, sessionDir, sessionId, meta);
      }
    }
    return handleFor(storage, sessionDir, sessionId, meta, attachNonce);
  } catch (error) {
    // The lock above is ours; an attach that fails must not strand it.
    await storage?.close(context).catch(() => undefined);
    releaseSessionLock(sessionDir, attachNonce);
    throw error;
  }
}

export function listSessions(
  store: SessionStore,
  _context: Context,
): Promise<SessionListEntry[]> {
  const entries: SessionListEntry[] = [];
  for (const dir of listDirOrNothing(store.bridge, store.root)) {
    if (!isSessionShaped(dir)) continue;
    // A directory without a storage is not a session: an interrupted create
    // leaves a lock (or a journal) behind, and listing it would invent one.
    if (!store.bridge.exists(storagePathOf(dir.path))) continue;
    const meta = readSessionHeader(store, dir.path);
    entries.push({ id: dir.name, ...(meta === undefined ? {} : { meta }) });
  }
  // Order: newest first, then by id, then by workspace. ISO-8601 UTC
  // timestamps sort lexicographically, so the stored string is the key.
  return Promise.resolve(
    entries.sort(
      (left, right) =>
        (right.meta?.createdAt ?? '').localeCompare(
          left.meta?.createdAt ?? '',
        ) ||
        left.id.localeCompare(right.id) ||
        (left.meta?.cwd ?? '').localeCompare(right.meta?.cwd ?? ''),
    ),
  );
}

// The other sessions recorded against `workspace`, read synchronously from
// their listing headers — the end-of-run sweep that asks is synchronous. The
// recorded workspace is `meta.workspace`, else the session's cwd.
export function workspacePeers(
  store: SessionStore,
  workspace: string,
  self: string,
): Array<{ id: string; dir: string }> {
  const peers: Array<{ id: string; dir: string }> = [];
  for (const entry of listDirOrNothing(store.bridge, store.root)) {
    if (!isSessionShaped(entry) || entry.name === self) continue;
    const meta = readSessionHeader(store, entry.path);
    if ((meta?.workspace ?? meta?.cwd) === workspace) {
      peers.push({ id: entry.name, dir: sessionDirOf(store, entry.name) });
    }
  }
  return peers;
}

// Repo-level overlap probe (blind spot): the ids of
// every session recorded against `workspace`. Two different sessions on
// one workspace are LEGAL (warning only, never a block) — but each run's
// end-of-run sweep attributes the other's in-flight changes as
// unattributed, non-reversible entries, and this probe is how that
// limitation is surfaced (the sweep debug line and the `kubic doctor`
// note). The recorded workspace is `meta.workspace` when the session
// declared one, its cwd otherwise. Local-store view only: no cross-host
// truth is claimed.
export function sessionsTouchingWorkspace(
  store: SessionStore,
  workspace: string,
  context: Context,
): Promise<string[]> {
  return listSessions(store, context).then((entries) =>
    entries
      .filter(
        (entry) => (entry.meta?.workspace ?? entry.meta?.cwd) === workspace,
      )
      .map((entry) => entry.id),
  );
}
