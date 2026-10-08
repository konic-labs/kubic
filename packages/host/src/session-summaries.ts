// The sessions the TUI's `/resume` picker lists: this project's sessions,
// newest first, each with its title (the first prompt), turns, cost and age.
// Read the way `kubic cost` reads (session-read.ts): a session another live
// process holds is never opened (pi-durable: one process per storage). It is
// listed, greyed, so the picker can say why it cannot be resumed.

import { join } from 'node:path';
import {
  listSessions,
  openSessionStore,
  sessionLockIsLive,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readSessionEntries,
} from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type Storage,
} from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { readSessionUsage, totalSessionUsage } from './ops/cost/cost-cli.js';
import {
  openReadOnlySessionStorage,
  touchesWorkspace,
} from './session-read.js';

export interface SessionSummary {
  readonly id: string;
  /** ISO time the session was created. */
  readonly createdAt?: string;
  /** The first prompt of its active transcript, on one line. */
  readonly title?: string;
  /** Prompts in its active transcript. */
  readonly turns?: number;
  readonly costUsd?: number;
  /** `live`: another process holds it. */
  readonly state: 'ready' | 'live';
}

export interface SummarizeOptions {
  readonly sessionsRoot: string;
  readonly workspace: string;
  /** The session asking (never listed). */
  readonly exclude?: string;
  /** Newest first, at most this many (default 30). */
  readonly limit?: number;
  readonly context?: Context;
}

const TITLE_CHARS = 80;

/** This project's sessions, newest first, with what the picker shows. */
export async function summarizeProjectSessions(
  options: SummarizeOptions,
): Promise<SessionSummary[]> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const store = openSessionStore(
    options.sessionsRoot,
    createNodeFileBridge(options.sessionsRoot),
  );
  const listed = (await listSessions(store, context))
    .filter(
      (entry) =>
        entry.id !== options.exclude &&
        touchesWorkspace(
          entry.meta?.workspace ?? entry.meta?.cwd,
          options.workspace,
        ),
    )
    .sort((a, b) =>
      (b.meta?.createdAt ?? '').localeCompare(a.meta?.createdAt ?? ''),
    )
    .slice(0, options.limit ?? 30);
  const summaries: SessionSummary[] = [];
  for (const entry of listed) {
    const base = {
      id: entry.id,
      ...(entry.meta?.createdAt === undefined
        ? {}
        : { createdAt: entry.meta.createdAt }),
    };
    const dir = join(options.sessionsRoot, entry.id);
    if (sessionLockIsLive(dir) !== undefined) {
      summaries.push({ ...base, state: 'live' });
      continue;
    }
    let storage: Storage;
    try {
      storage = await openReadOnlySessionStorage(
        options.sessionsRoot,
        entry.id,
      );
    } catch {
      summaries.push({ ...base, state: 'ready' });
      continue;
    }
    try {
      const prompts = entriesToTranscript(
        await readSessionEntries(storage, context),
      ).filter((item) => item.kind === 'user');
      const first = prompts[0]?.text.split('\n')[0]?.trim() ?? '';
      const cost = totalSessionUsage(await readSessionUsage(storage, context));
      summaries.push({
        ...base,
        ...(first === '' ? {} : { title: first.slice(0, TITLE_CHARS) }),
        turns: prompts.length,
        costUsd: cost.costUsd,
        // The read raced a new holder: what was read may be partial.
        state: sessionLockIsLive(dir) === undefined ? 'ready' : 'live',
      });
    } catch {
      summaries.push({ ...base, state: 'ready' });
    } finally {
      await storage.close(context);
    }
  }
  return summaries;
}
