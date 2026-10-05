// Session storage on pi-durable (issue #392; §21–§22). One durable Session
// per session directory, one storage per session: sessions live under
// <sessions-root>/<id>/, and the storage's JSONL files sit in that directory
// beside the Kubic state it already held (journal, spans, posture, lock).
//
// Layout, per session:
//   <root>/<id>/main.jsonl          pi-durable JSONL storage (conversations,
//                                   documents, tasks — the session's truth)
//   <root>/<id>/doc-<n>.jsonl       the storage's document sidecars
//   <root>/<id>/session.json        Kubic's LISTING HEADER (see below)
//   <root>/<id>/lock.json           the Kubic session lock (issue #118)
//   <root>/<id>/journal|spans…      the rest of the session's state
//
// Two records hold the session's metadata, and the split is deliberate:
//   - the `kubic.session` document, written in the creating commit, is the
//     session's own metadata: anything that has the session open reads it
//     from the storage (readSessionMetadata).
//   - `<id>/session.json` is the listing header: `listSessions` and
//     `sessionsTouchingWorkspace` run on every `kubic run` boot (the overlap
//     probe) and in `kubic doctor`, and pi-durable states that ONE PROCESS
//     OWNS A STORAGE AT A TIME. Listing must therefore never open a session
//     storage — a live session's would be a second owner, and recovery can
//     truncate a file the live writer is appending to. The header is written
//     once, from the same value as the document, and re-synced from the
//     document on attach.
//
// fsync: OFF (pi-durable's default). 0.87's JSONL session storage never
// fsynced, so this is parity, not a downgrade: a process crash loses nothing
// (the page cache outlives it) and a power loss costs at most the newest
// commit, which recovery drops whole. The change journal is Kubic's fsync'd
// store (§42.4) — that is where "this change can be undone" is guaranteed.
//
// Legacy sessions (Pi 0.87): a transcript written by the removed
// JsonlSessionRepo lives at <root>/--<cwd>--/<ts>_<id>.jsonl. It is listed as
// `format: 'legacy'` and refused on attach with SessionFormatError — no
// converter, the repo is unreleased (§21).

import { dirname, join } from 'node:path';
import type {
  BridgeFileInfo,
  FileBridge,
} from '../../../exec/src/file-bridge.js';
import {
  createLockFile,
  readLockFile,
  removeLockFile,
  tightenStateDir,
} from '../../../exec/src/lock-file.js';
import {
  type Context,
  type ConversationId,
  createSession as createSessionKernel,
  defineDoc,
  type EntryId,
  JsonlStorage,
  type JsonValue,
  ROOT_CONVERSATION_ID,
  type Storage,
  UsageDoc,
  uuidv7,
} from '../pi-boundary.js';
import { bridgeToPiFileSystem } from './session-fs.js';

// Session ids are path segments under the sessions root, so the character
// class is a containment rule, not a style: `join(root, id)` must never leave
// the root. The same class the CLI validates (`SESSION_ID_PATTERN`,
// packages/host/src/run-cli.ts) and `sessions prune` uses.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// pi's transcript directories: `--<cwd with /, \ and : mapped to -->--`. Their
// name passes the id class, but they hold the transcripts of EVERY session
// recorded against that cwd (0.87 layout), never one session's state dir.
const LEGACY_DIR_PATTERN = /^--.*--$/;

// A usable session id is a plain path segment that is NOT shaped like a pi
// transcript directory: `listSessions` classifies `--…--` as the 0.87 layout,
// so a session with such an id would be invisible to `sessions list`, the
// overlap probe and `kubic doctor` — attachable, but unlistable. Refusing the
// shape on both paths is the containment rule the id class already carries.
function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) && !LEGACY_DIR_PATTERN.test(id);
}

// A JSONL header is one short line (`{kind:"kubic.session",…}` for Kubic's,
// `{v:4,kind:"header",…}` for a 0.87 transcript); this bounds the read so
// listing never pulls a whole transcript into memory.
const HEADER_WINDOW_BYTES = 64 * 1024;

export interface SessionStore {
  root: string;
  bridge: FileBridge;
}

export function openSessionStore(
  root: string,
  bridge: FileBridge,
): SessionStore {
  return { root, bridge };
}

// Session metadata (issue #392; §21): what the store records about a session
// at creation — the fields 0.87's `session.metadata` carried. `cwd` is the
// directory the session was created against; `workspace` is the workspace it
// belongs to when the caller declares one (the journal/overlap association),
// absent when it does not. Extra keys are allowed so a later Kubic version can
// add session facts without a store migration.
export interface KubicSessionMeta {
  cwd: string;
  createdAt: string;
  workspace?: string;
  // Issue #164 (§22–§23): the orchestrate run this session belongs to —
  // the manager session's id for a worker, absent for a root (a solo run,
  // a manager record itself). Plus the role/agent the run spawned it as.
  // Linkage only: never a transcript, message history or entry reference.
  parentSessionId?: string;
  role?: string;
  agentId?: string;
  // Issue #265 (§22.3): a forked session's lane runs a FORK of the source's
  // conversation, not the reserved root: its id is recorded here (absent ⇒
  // the root), with where it came from.
  conversation?: number;
  forkedFrom?: { session: string; at: number };
  [k: string]: JsonValue | undefined;
}

// The session-scoped Kubic document: the session's metadata, committed with
// the session itself so a reader with the storage open gets it from the same
// durable state as the transcript. `id` is stored for legibility — the
// directory name is the identity.
export const KubicSessionDoc = defineDoc<{
  id: string;
  cwd: string;
  createdAt: string;
  workspace?: string;
  conversation?: number;
  forkedFrom?: { session: string; at: number };
  parentSessionId?: string;
  role?: string;
  agentId?: string;
}>({
  kind: 'kubic.session',
  version: 1,
  scope: 'session',
  initial: () => ({ id: '', cwd: '', createdAt: '' }),
});

// One attached session: the open storage, the session's metadata, and the
// release that gives both back. Replaces Pi 0.87's `Session` (issue #392).
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
   * Hand the storage to a durable Harness (K5 #394):
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

// One listed session. `format` is 'legacy' for a Pi 0.87 transcript: it is
// listed so the operator can see it, and it can never be attached. `meta` is
// absent when nothing readable recorded it (a hand-made or half-written
// session directory) — listing never guesses.
export type SessionListEntry = {
  id: string;
  meta?: KubicSessionMeta;
  format: 'durable' | 'legacy';
};

export class SessionIdError extends Error {
  constructor(id: string) {
    super(`invalid session id: ${id}`);
    this.name = 'SessionIdError';
  }
}

// Session locking (issue #118; §21–§22): one live attachment per session.
// The lock file is <sessions-root>/<id>/lock.json — `{pid, startedAt}` of
// the attaching process. It wraps EVERY storage open (issue #392): pi-durable
// owns a storage exclusively and does no cross-process locking, so the Kubic
// lock is the only guard against two processes appending to one session.
// LOCAL FILESYSTEM ONLY: O_EXCL create is atomic on a local fs (and on
// volumes that honor it), but no network/shared-disk locking semantics are
// claimed — see docs/packages/worker.md.
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
  // Issue #361: a session directory is private state; an existing loose one
  // (created before this, or by hand) is closed on the way in — and so is the
  // sessions root, which is what `kubic doctor` reports and what the docs
  // promise the next open tightens. The root holds nothing but these session
  // directories, so 0700 is its correct posture.
  tightenStateDir(sessionDir);
  tightenStateDir(dirname(sessionDir));
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

// The listing header: Kubic's projection of the session metadata, read by
// listing without opening the storage (see the file header). It is rewritten
// from the document whenever a session is attached, so a document that gains a
// field cannot leave a stale listing behind.
const SESSION_HEADER_FILE = 'session.json';
const SESSION_HEADER_VERSION = 1;

function sessionDirOf(store: SessionStore, id: string): string {
  return join(store.root, id);
}

function headerPathOf(sessionDir: string): string {
  return join(sessionDir, SESSION_HEADER_FILE);
}

function storagePathOf(sessionDir: string): string {
  return join(sessionDir, 'main.jsonl');
}

// Best-effort directory listing: a missing or unreadable sessions root is a
// fresh (or damaged) machine, never a throw — the listing's callers treat it
// as "nothing recorded" (issue #362).
function listDirOrNothing(bridge: FileBridge, path: string): BridgeFileInfo[] {
  try {
    return bridge.listDir(path);
  } catch {
    return [];
  }
}

function isSessionShaped(entry: BridgeFileInfo): boolean {
  return (
    entry.isDirectory &&
    !entry.isSymbolicLink &&
    SESSION_ID_PATTERN.test(entry.name) &&
    !LEGACY_DIR_PATTERN.test(entry.name)
  );
}

// The first line of a file, bounded: session headers are one short JSON line,
// and listing a store of large transcripts must not read them whole. The node
// bridge serves the bounded window; a bridge without the range read falls back
// to a line read.
function readFirstLine(bridge: FileBridge, path: string): string | undefined {
  let text: string;
  try {
    const window = bridge.readFileRange?.(path, 0, HEADER_WINDOW_BYTES);
    text =
      window === undefined
        ? (bridge.readTextLines(path, 1)[0] ?? '')
        : new TextDecoder().decode(window);
  } catch {
    return undefined;
  }
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

function parseJsonObject(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// An ISO-8601 timestamp from a stored value: Kubic writes ISO strings, a 0.87
// header carries milliseconds. Anything else is "unrecorded" — the listing
// omits the metadata rather than inventing a time.
function isoFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

// The metadata a stored record actually holds. `cwd` and `createdAt` are both
// required: a record missing either is not usable metadata, and the caller
// treats it as absent (listing) or refuses the session (attach).
function metaFrom(
  value: Record<string, unknown> | undefined,
): KubicSessionMeta | undefined {
  if (value === undefined) return undefined;
  const cwd =
    typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined;
  const createdAt = isoFrom(value.createdAt);
  if (cwd === undefined || createdAt === undefined) return undefined;
  const conversation = value.conversation;
  const forkedFrom = value.forkedFrom as Record<string, unknown> | undefined;
  const parentSessionId =
    typeof value.parentSessionId === 'string' &&
    value.parentSessionId !== '' &&
    isSessionId(value.parentSessionId)
      ? value.parentSessionId
      : undefined;
  const role =
    typeof value.role === 'string' && value.role !== ''
      ? value.role
      : undefined;
  const agentId =
    typeof value.agentId === 'string' && value.agentId !== ''
      ? value.agentId
      : undefined;
  return {
    cwd,
    createdAt,
    ...(typeof value.workspace === 'string' && value.workspace !== ''
      ? { workspace: value.workspace }
      : {}),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(role === undefined ? {} : { role }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(typeof conversation === 'number' && Number.isSafeInteger(conversation)
      ? { conversation }
      : {}),
    ...(forkedFrom !== undefined &&
    typeof forkedFrom.session === 'string' &&
    typeof forkedFrom.at === 'number'
      ? { forkedFrom: { session: forkedFrom.session, at: forkedFrom.at } }
      : {}),
  };
}

/**
 * Issue #265: the conversation a session's lane runs — a fork's recorded
 * conversation, else the reserved root. Every reader of "the session's
 * transcript" resolves it through here.
 */
export function laneConversationIdOf(
  meta: Pick<KubicSessionMeta, 'conversation'> | undefined,
): ConversationId {
  return meta?.conversation === undefined
    ? ROOT_CONVERSATION_ID
    : (meta.conversation as ConversationId);
}

/** A fork the store refused, named for the operator (exit code by the CLI). */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError';
}

export interface ForkSessionOptions {
  /** Entry to fork at (inclusive); default: the source lane's newest entry. */
  at?: number;
  /** Copy the whole tree: every conversation and branch tip, lane unchanged. */
  tree?: boolean;
  /** The new session's id (default: a fresh uuid v7). */
  id?: string;
}

export interface ForkSessionResult {
  id: string;
  source: string;
  /** The entry the fork cut at; undefined for a `tree` copy. */
  at?: number;
}

/**
 * Issue #265 (§22.3): a new session forked from an existing one. The source
 * storage files (`main.jsonl` + document sidecars) are copied into a fresh
 * session directory — under the source's own lock, so a live session is
 * refused (SessionLockError) and no run can start mid-copy — and nothing
 * else: no journal, spans, posture or approvals (a fork starts enforced).
 * A branch fork then creates, in the NEW session's storage, a pi-durable
 * fork of the source lane at `at` (which inherits history through `at` and
 * the agent as of it, and leaves pending work and usage behind) and records
 * it as the lane conversation; a `tree` fork keeps every conversation and
 * branch tip as it is. The new id is usable at once with `--session`.
 */
export async function forkSession(
  store: SessionStore,
  sourceId: string,
  options: ForkSessionOptions,
  context: Context,
): Promise<ForkSessionResult> {
  if (!isSessionId(sourceId)) throw new SessionIdError(sourceId);
  const sourceDir = sessionDirOf(store, sourceId);
  if (!store.bridge.exists(storagePathOf(sourceDir))) {
    if (findLegacyTranscript(store, sourceId) !== undefined)
      throw new SessionFormatError(sourceId);
    throw new SessionAttachError(sourceId);
  }
  const id = options.id ?? uuidv7();
  if (!isSessionId(id)) throw new SessionIdError(id);
  const targetDir = sessionDirOf(store, id);
  if (store.bridge.exists(storagePathOf(targetDir)))
    throw new Error(`Session already exists: ${id}`);
  acquireSessionLock(sourceDir, sourceId);
  let sourceMeta: KubicSessionMeta | undefined;
  try {
    acquireSessionLock(targetDir, id);
    try {
      const sourceStorage = await openSessionStorage(store, sourceDir, context);
      try {
        sourceMeta = await readSessionMetadata(sourceStorage, context);
      } finally {
        await sourceStorage.close(context);
      }
      for (const entry of store.bridge.listDir(sourceDir)) {
        if (!entry.isFile) continue;
        if (entry.name !== 'main.jsonl' && !/^doc-\d+\.jsonl$/.test(entry.name))
          continue;
        store.bridge.writeFile(
          join(targetDir, entry.name),
          store.bridge.readBinaryFile(entry.path),
          { mode: 0o600 },
        );
      }
    } catch (error) {
      releaseSessionLock(targetDir);
      throw error;
    }
  } finally {
    releaseSessionLock(sourceDir);
  }
  try {
    if (sourceMeta === undefined)
      throw new SessionForkError(`session ${sourceId} has no Kubic metadata`);
    const lane = laneConversationIdOf(sourceMeta);
    const meta: KubicSessionMeta = {
      cwd: sourceMeta.cwd,
      createdAt: new Date().toISOString(),
      ...(sourceMeta.workspace === undefined
        ? {}
        : { workspace: sourceMeta.workspace }),
      // Issue #164: a fork stays in its run's tree — the copied document
      // already carries the ancestry, and the header must agree with it so
      // listSessions sees the lineage before the first attach re-syncs.
      ...(sourceMeta.parentSessionId === undefined
        ? {}
        : { parentSessionId: sourceMeta.parentSessionId }),
      ...(sourceMeta.role === undefined ? {} : { role: sourceMeta.role }),
      ...(sourceMeta.agentId === undefined
        ? {}
        : { agentId: sourceMeta.agentId }),
    };
    let at: number | undefined;
    const storage = await openSessionStorage(store, targetDir, context);
    const kernel = createSessionKernel(storage);
    try {
      await kernel.commit(async (tx) => {
        const doc = await tx.doc(KubicSessionDoc);
        doc.id = id;
        doc.cwd = meta.cwd;
        doc.createdAt = meta.createdAt;
        if (meta.workspace !== undefined) doc.workspace = meta.workspace;
        delete doc.conversation;
        delete doc.forkedFrom;
        // §22.3: a fork starts with no usage of its own — the copied
        // conversations' `pi.usage` documents are emptied in the creating
        // commit, so `kubic cost` never counts the source's spend twice.
        let page = await tx.scanConversations({}, 256);
        for (;;) {
          for (const record of page.items) {
            const usage = await tx.doc(UsageDoc, record.id);
            usage.models = {};
            usage.tools = {};
          }
          if (page.next === undefined) break;
          page = await tx.scanConversations({}, 256, page.next);
        }
        if (options.tree === true) {
          if (sourceMeta?.conversation !== undefined)
            doc.conversation = sourceMeta.conversation;
          return;
        }
        const newest = (
          await tx.scanEntries({ conversationId: lane }, 1, undefined)
        ).items[0];
        if (newest === undefined)
          throw new SessionForkError(
            `session ${sourceId} has no entries to fork`,
          );
        at = options.at ?? Number(newest.id);
        const forked = await tx.forkConversation(lane, at as EntryId, {
          ownership: { kind: 'ownerless' },
        });
        doc.conversation = Number(forked.id);
        doc.forkedFrom = { session: sourceId, at };
      }, context);
    } catch (error) {
      if (error instanceof SessionForkError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new SessionForkError(
        `cannot fork session ${sourceId}${options.at === undefined ? '' : ` at entry ${options.at}`}: ${detail}`,
      );
    } finally {
      await kernel.close(context);
    }
    writeSessionHeader(store, targetDir, id, meta);
    return { id, source: sourceId, ...(at === undefined ? {} : { at }) };
  } catch (error) {
    for (const entry of store.bridge.exists(targetDir)
      ? store.bridge.listDir(targetDir)
      : []) {
      if (entry.name === 'lock.json') continue;
      try {
        store.bridge.remove(entry.path, false, true);
      } catch {
        // Best-effort cleanup; the failure that got us here is the report.
      }
    }
    throw error;
  } finally {
    releaseSessionLock(targetDir);
  }
}

function writeSessionHeader(
  store: SessionStore,
  sessionDir: string,
  id: string,
  meta: KubicSessionMeta,
): void {
  // Issue #361: the header carries the session's workspace and metadata —
  // private state, 0600 at creation.
  store.bridge.writeFile(
    headerPathOf(sessionDir),
    `${JSON.stringify({
      v: SESSION_HEADER_VERSION,
      kind: 'kubic.session',
      id,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      ...(meta.workspace === undefined ? {} : { workspace: meta.workspace }),
      // Issue #164: the listing projection carries the ancestry, so
      // listSessions surfaces the tree without opening any storage.
      ...(meta.parentSessionId === undefined
        ? {}
        : { parentSessionId: meta.parentSessionId }),
      ...(meta.role === undefined ? {} : { role: meta.role }),
      ...(meta.agentId === undefined ? {} : { agentId: meta.agentId }),
    })}\n`,
    { mode: 0o600 },
  );
}

function readSessionHeader(
  store: SessionStore,
  sessionDir: string,
): KubicSessionMeta | undefined {
  if (!store.bridge.exists(headerPathOf(sessionDir))) return undefined;
  return metaFrom(
    parseJsonObject(readFirstLine(store.bridge, headerPathOf(sessionDir))),
  );
}

// The session's own metadata, read from the storage it was committed to
// (issue #392). This is a `Storage` read, not a Session commit: it needs no
// kernel, so the caller keeps the storage it will hand to the harness.
export async function readSessionMetadata(
  storage: Storage,
  context: Context,
): Promise<KubicSessionMeta | undefined> {
  const record = await storage.findDocument(
    { kind: 'kubic.session', scope: { kind: 'session' } },
    'current',
    context,
  );
  if (record === undefined) return undefined;
  const stored = await storage.document(record.id, 'current', context);
  if (stored === undefined) return undefined;
  return metaFrom(stored.value as Record<string, unknown>);
}

async function openSessionStorage(
  store: SessionStore,
  sessionDir: string,
  context: Context,
): Promise<Storage> {
  // The portable core over the exec bridge, never the `/node` entry point:
  // session bytes keep crossing the I/O seam, where the #359 secret scrubbing
  // and the #361 file modes live (see session-fs.ts). fsync stays off — the
  // file header explains why.
  return JsonlStorage.open(
    sessionDir,
    bridgeToPiFileSystem(store.bridge),
    context,
    { fsync: false },
  );
}

// Release gives the lock back, and gives the storage back too while the handle
// still owns it (issue #118, #392): every consumer's release path gets the
// unlock for free, so no caller can leak a lock by forgetting an unlock step.
// A storage a harness adopted is never closed from under it — the harness owns
// it and closes it — and every step is idempotent.
function handleFor(
  storage: Storage,
  sessionDir: string,
  id: string,
  meta: KubicSessionMeta,
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
        releaseSessionLock(sessionDir);
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
    parentSessionId?: string;
    role?: string;
    agentId?: string;
  },
  context: Context,
): Promise<SessionHandle> {
  const sessionId = opts.id ?? uuidv7();
  if (!isSessionId(sessionId)) throw new SessionIdError(sessionId);
  // Issue #164: the parent link is a session id or nothing — a value that
  // cannot name a session directory is refused before anything is written.
  if (
    opts.parentSessionId !== undefined &&
    !isSessionId(opts.parentSessionId)
  ) {
    throw new SessionIdError(opts.parentSessionId);
  }
  const sessionDir = sessionDirOf(store, sessionId);
  // Refusals before the lock: a session that already exists is never
  // re-created over (0.87's `Session already exists: <id>`, same message),
  // and an id that belongs to a Pi 0.87 session is refused by name — reusing
  // it would mix a new durable session into the old session's journal, spans
  // and approval posture.
  if (store.bridge.exists(storagePathOf(sessionDir)))
    throw new Error(`Session already exists: ${sessionId}`);
  if (findLegacyTranscript(store, sessionId) !== undefined)
    throw new SessionFormatError(sessionId);
  // The lock is acquired FIRST (issue #392): it is the only guard around a
  // storage open, so it must be held before the storage exists, not after.
  // The lock primitive creates the session dir eagerly, which is also the
  // storage's directory.
  acquireSessionLock(sessionDir, sessionId);
  try {
    const meta: KubicSessionMeta = {
      cwd: opts.cwd,
      createdAt: new Date().toISOString(),
      ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }),
      ...(opts.parentSessionId === undefined
        ? {}
        : { parentSessionId: opts.parentSessionId }),
      ...(opts.role === undefined ? {} : { role: opts.role }),
      ...(opts.agentId === undefined ? {} : { agentId: opts.agentId }),
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
        if (meta.parentSessionId !== undefined)
          doc.parentSessionId = meta.parentSessionId;
        if (meta.role !== undefined) doc.role = meta.role;
        if (meta.agentId !== undefined) doc.agentId = meta.agentId;
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
    );
  } catch (error) {
    // A create that fails must not strand its lock, and must not leave a
    // half-made storage behind: the guard above would then refuse every
    // retry as `Session already exists`. The files this call created are
    // removed (the directory and anything predating the call stay); any
    // orphaned sidecar is dropped by the next open's recovery.
    releaseSessionLock(sessionDir);
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

// A session directory written by Kubic on Pi 0.87 (issue #392). The repo is
// unreleased, so there is no converter: the refusal is the whole behaviour.
export class SessionFormatError extends Error {
  constructor(sessionId: string) {
    super(
      `session ${sessionId} was written by Kubic on Pi 0.87; start a new session`,
    );
    this.name = 'SessionFormatError';
  }
}

// The 0.87 transcript of `id`, if the sessions root holds one: the
// JsonlSessionRepo layout, `<root>/--<cwd>--/<ts>_<id>.jsonl`, whose first
// line is the format-4 header. Matching is by that header, so a transcript
// whose file name was changed is still recognised. A torn or foreign `.jsonl`
// is not a 0.87 session and never claims the id.
function findLegacyTranscript(
  store: SessionStore,
  id: string,
): string | undefined {
  for (const dir of listDirOrNothing(store.bridge, store.root)) {
    if (!dir.isDirectory || !LEGACY_DIR_PATTERN.test(dir.name)) continue;
    for (const file of listDirOrNothing(store.bridge, dir.path)) {
      if (file.isFile === false || !file.name.endsWith('.jsonl')) continue;
      const header = parseJsonObject(readFirstLine(store.bridge, file.path));
      if (header === undefined) continue;
      if (header.kind !== 'header' || header.v !== 4) continue;
      if (header.id === id) return file.path;
    }
  }
  return undefined;
}

export async function attachSession(
  store: SessionStore,
  sessionId: string,
  context: Context,
): Promise<SessionHandle> {
  // Containment before any path join: the id becomes a directory name.
  if (!isSessionId(sessionId)) throw new SessionAttachError(sessionId);
  const sessionDir = sessionDirOf(store, sessionId);
  // Nothing to open: either a 0.87 transcript holds this id (refused by name)
  // or the store has never seen it. Checked before the lock so an unknown id
  // never creates a session directory.
  if (!store.bridge.exists(storagePathOf(sessionDir))) {
    if (findLegacyTranscript(store, sessionId) !== undefined)
      throw new SessionFormatError(sessionId);
    throw new SessionAttachError(sessionId);
  }
  // The lock is held before the storage is opened (issue #118, #392): no
  // reader ever observes a session another live attachment is writing, and no
  // second process ever opens the same pi-durable storage.
  acquireSessionLock(sessionDir, sessionId);
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
        header.workspace !== meta.workspace ||
        header.parentSessionId !== meta.parentSessionId ||
        header.role !== meta.role ||
        header.agentId !== meta.agentId
      ) {
        writeSessionHeader(store, sessionDir, sessionId, meta);
      }
    }
    return handleFor(storage, sessionDir, sessionId, meta);
  } catch (error) {
    // The lock above is ours; an attach that fails must not strand it.
    await storage?.close(context).catch(() => undefined);
    releaseSessionLock(sessionDir);
    throw error;
  }
}

export function listSessions(
  store: SessionStore,
  _context: Context,
): Promise<SessionListEntry[]> {
  const entries = new Map<string, SessionListEntry>();
  // Legacy transcripts first, so a current-format session with the same id
  // wins the map.
  for (const dir of listDirOrNothing(store.bridge, store.root)) {
    if (!dir.isDirectory || !LEGACY_DIR_PATTERN.test(dir.name)) continue;
    for (const file of listDirOrNothing(store.bridge, dir.path)) {
      if (file.isFile === false || !file.name.endsWith('.jsonl')) continue;
      const header = parseJsonObject(readFirstLine(store.bridge, file.path));
      if (header === undefined) continue;
      if (header.kind !== 'header' || header.v !== 4) continue;
      // The id is rendered by `kubic sessions list` (#400): a foreign or
      // hand-edited header whose id is not a session id is skipped, never
      // listed.
      if (typeof header.id !== 'string' || !isSessionId(header.id)) continue;
      const meta = metaFrom(header);
      entries.set(header.id, {
        id: header.id,
        ...(meta === undefined ? {} : { meta }),
        format: 'legacy',
      });
    }
  }
  for (const dir of listDirOrNothing(store.bridge, store.root)) {
    if (!isSessionShaped(dir)) continue;
    // A directory without a storage is not a session: an interrupted create
    // leaves a lock (or a journal) behind, and listing it would invent one.
    if (!store.bridge.exists(storagePathOf(dir.path))) continue;
    const meta = readSessionHeader(store, dir.path);
    entries.set(dir.name, {
      id: dir.name,
      ...(meta === undefined ? {} : { meta }),
      format: 'durable',
    });
  }
  // 0.87's order: newest first, then by id, then by workspace. ISO-8601 UTC
  // timestamps sort lexicographically, so the stored string is the key.
  return Promise.resolve(
    [...entries.values()].sort(
      (left, right) =>
        (right.meta?.createdAt ?? '').localeCompare(
          left.meta?.createdAt ?? '',
        ) ||
        left.id.localeCompare(right.id) ||
        (left.meta?.cwd ?? '').localeCompare(right.meta?.cwd ?? ''),
    ),
  );
}

// Repo-level overlap probe (issue #118; §42.5 blind spot): the ids of
// every session recorded against `workspace`. Two different sessions on
// one workspace are LEGAL (warning only, never a block) — but each run's
// end-of-run sweep attributes the other's in-flight changes as
// unattributed, non-reversible entries, and this probe is how that
// limitation is surfaced (the sweep debug line and the `kubic doctor`
// note). The recorded workspace is `meta.workspace` when the session
// declared one, its cwd otherwise. Local-store view only: no cross-host
// truth is claimed.
//
// Legacy 0.87 transcripts are excluded: they cannot be attached, so they can
// never be the live sibling this probe warns about.
export function sessionsTouchingWorkspace(
  store: SessionStore,
  workspace: string,
  context: Context,
): Promise<string[]> {
  return listSessions(store, context).then((entries) =>
    entries
      .filter(
        (entry) =>
          entry.format === 'durable' &&
          (entry.meta?.workspace ?? entry.meta?.cwd) === workspace,
      )
      .map((entry) => entry.id),
  );
}
