// The session layout on disk and its metadata document: where a session's
// header and storage live, and how a header is written and read.

import { join } from 'node:path';
import type { BridgeFileInfo, FileBridge } from '@kubic/exec/file-bridge';
import type { RunMode } from '../../permissions.js';
import type {
  Context,
  ConversationId,
  JsonValue,
  Storage,
} from '../../pi-boundary.js';
import { defineDoc, ROOT_CONVERSATION_ID } from '../../pi-boundary.js';
import { SESSION_ID_PATTERN } from './ids.js';

// A JSONL header is one short line (`{kind:"kubic.session",…}`); this bounds
// the read so listing never pulls a whole transcript into memory.
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

// Session metadata: what the store records about a session
// at creation. `cwd` is the
// directory the session was created against; `workspace` is the workspace it
// belongs to when the caller declares one (the journal/overlap association),
// absent when it does not. Extra keys are allowed so a later Kubic version can
// add session facts without a store migration.
export interface KubicSessionMeta {
  cwd: string;
  createdAt: string;
  workspace?: string;
  // A forked session's lane runs a FORK of the source's
  // conversation, not the reserved root: its id is recorded here (absent ⇒
  // the root), with where it came from.
  conversation?: number;
  forkedFrom?: { session: string; at: number };
  // The run's mode, recorded when the run names it
  // (absent ⇒ off by default, never assumed).
  mode?: RunMode;
  // Who ran it — the OS user — and the `[cost] team` it is billed to:
  // what `kubic cost --by user|team` groups on. Absent on older sessions.
  user?: string;
  team?: string;
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
  mode?: RunMode;
  user?: string;
  team?: string;
}>({
  kind: 'kubic.session',
  version: 1,
  scope: 'session',
  initial: () => ({ id: '', cwd: '', createdAt: '' }),
  // Store every change as a delta; no periodic base.
  checkpointWhen: () => false,
});

// One listed session. `meta` is absent when nothing readable recorded it (a
// hand-made or half-written session directory) — listing never guesses.
export type SessionListEntry = {
  id: string;
  meta?: KubicSessionMeta;
};

// The listing header: Kubic's projection of the session metadata, read by
// listing without opening the storage (see the file header). It is rewritten
// from the document whenever a session is attached, so a document that gains a
// field cannot leave a stale listing behind.
const SESSION_HEADER_FILE = 'session.json';
const SESSION_HEADER_VERSION = 1;

export function sessionDirOf(store: SessionStore, id: string): string {
  return join(store.root, id);
}

export function headerPathOf(sessionDir: string): string {
  return join(sessionDir, SESSION_HEADER_FILE);
}

export function storagePathOf(sessionDir: string): string {
  return join(sessionDir, 'main.jsonl');
}

// Best-effort directory listing: a missing or unreadable sessions root is a
// fresh (or damaged) machine, never a throw — the listing's callers treat it
// as "nothing recorded".
export function listDirOrNothing(
  bridge: FileBridge,
  path: string,
): BridgeFileInfo[] {
  try {
    return bridge.listDir(path);
  } catch {
    return [];
  }
}

export function isSessionShaped(entry: BridgeFileInfo): boolean {
  return (
    entry.isDirectory &&
    !entry.isSymbolicLink &&
    SESSION_ID_PATTERN.test(entry.name)
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

// An ISO-8601 timestamp from a stored value: Kubic writes ISO strings.
// Anything else is "unrecorded" — the listing omits the metadata rather than
// inventing a time.
function isoFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
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
  return {
    cwd,
    createdAt,
    ...(typeof value.workspace === 'string' && value.workspace !== ''
      ? { workspace: value.workspace }
      : {}),
    // Only the two RunMode spellings survive the read —
    // a foreign or hand-edited value is absent, never a third mode.
    ...(value.mode === 'autonomous' || value.mode === 'interactive'
      ? { mode: value.mode }
      : {}),
    ...(typeof conversation === 'number' && Number.isSafeInteger(conversation)
      ? { conversation }
      : {}),
    ...(forkedFrom !== undefined &&
    typeof forkedFrom.session === 'string' &&
    typeof forkedFrom.at === 'number'
      ? { forkedFrom: { session: forkedFrom.session, at: forkedFrom.at } }
      : {}),
    ...(typeof value.user === 'string' && value.user !== ''
      ? { user: value.user }
      : {}),
    ...(typeof value.team === 'string' && value.team !== ''
      ? { team: value.team }
      : {}),
  };
}

/**
 * The conversation a session's lane runs — a fork's recorded
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

export function writeSessionHeader(
  store: SessionStore,
  sessionDir: string,
  id: string,
  meta: KubicSessionMeta,
): void {
  // The header carries the session's workspace and metadata —
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
      ...(meta.mode === undefined ? {} : { mode: meta.mode }),
      ...(meta.user === undefined ? {} : { user: meta.user }),
      ...(meta.team === undefined ? {} : { team: meta.team }),
    })}\n`,
    { mode: 0o600 },
  );
}

export function readSessionHeader(
  store: SessionStore,
  sessionDir: string,
): KubicSessionMeta | undefined {
  if (!store.bridge.exists(headerPathOf(sessionDir))) return undefined;
  return metaFrom(
    parseJsonObject(readFirstLine(store.bridge, headerPathOf(sessionDir))),
  );
}

// The session's own metadata, read from the storage it was committed to. This
// is a `Storage` read, not a Session commit: it needs no kernel, so the caller
// keeps the storage it will hand to the harness.
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
