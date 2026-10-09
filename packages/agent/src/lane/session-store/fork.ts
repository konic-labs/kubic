// Forking a session: a new session that starts from a copy of another's
// conversation up to a chosen entry.

import { join } from 'node:path';
import type { Context, EntryId } from '../../pi-boundary.js';
import {
  createSession as createSessionKernel,
  UsageDoc,
  uuidv7,
} from '../../pi-boundary.js';
import { isSessionId, SessionIdError } from './ids.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import type { KubicSessionMeta, SessionStore } from './meta.js';
import {
  KubicSessionDoc,
  laneConversationIdOf,
  readSessionMetadata,
  sessionDirOf,
  storagePathOf,
  writeSessionHeader,
} from './meta.js';
import { openSessionStorage, SessionAttachError } from './store.js';

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
 * A new session forked from an existing one. The source
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
  if (!store.bridge.exists(storagePathOf(sourceDir)))
    throw new SessionAttachError(sourceId);
  const id = options.id ?? uuidv7();
  if (!isSessionId(id)) throw new SessionIdError(id);
  const targetDir = sessionDirOf(store, id);
  if (store.bridge.exists(storagePathOf(targetDir)))
    throw new Error(`Session already exists: ${id}`);
  const sourceNonce = acquireSessionLock(sourceDir, sourceId);
  let sourceMeta: KubicSessionMeta | undefined;
  // Declared outside: the post-fork cleanup below releases the target
  // lock past the try that acquired it.
  let targetNonce: string | undefined;
  try {
    targetNonce = acquireSessionLock(targetDir, id);
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
      releaseSessionLock(targetDir, targetNonce);
      throw error;
    }
  } finally {
    releaseSessionLock(sourceDir, sourceNonce);
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
        // A fork starts with no usage of its own — the copied
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
    releaseSessionLock(targetDir, targetNonce);
  }
}
