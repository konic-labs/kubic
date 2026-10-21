// Spend caps at run time: what a run and this machine's UTC day have spent,
// measured from the cost the providers report on each model response, and the
// stop a `[policy]` cap calls for.
//
// The day's spend is read from the session store: every model response of
// every session that arrived since UTC midnight, counted once however many
// conversations of a session hold it. A session not written to today is
// skipped unread. A session another live run holds is skipped too (one
// process owns a storage): its spend counts once it ends, so two concurrent
// runs can each pass a daily cap the other has not reported yet.

import { join } from 'node:path';
import {
  listSessions,
  openSessionStore,
  sessionLockIsLive,
} from '@kubic/agent/lane/session-store';
import { entriesToTranscript } from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  type EntryRecord,
  type Storage,
} from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { SpendCaps } from '../config/index.js';
import { openReadOnlySessionStorage } from '../sessions/index.js';
import { formatCostUsd } from './session-cost.js';

const PAGE = 256;

/**
 * The start of the UTC day `now` falls in, in ms since the epoch.
 * @internal
 */
export function startOfUtcDay(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

// Every entry of every conversation of one storage, each entry id once.
async function allEntries(storage: Storage): Promise<EntryRecord[]> {
  const conversations: Array<
    Awaited<ReturnType<Storage['scanConversations']>>['items'][number]
  > = [];
  let cursor: Awaited<ReturnType<Storage['scanConversations']>>['next'];
  for (;;) {
    const page = await storage.scanConversations(
      {},
      PAGE,
      cursor,
      BACKGROUND_CONTEXT,
    );
    conversations.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  const seen = new Map<string, EntryRecord>();
  for (const conversation of conversations) {
    let next: Awaited<ReturnType<Storage['scanEntries']>>['next'];
    for (;;) {
      const page = await storage.scanEntries(
        { conversationId: conversation.id },
        PAGE,
        next,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) seen.set(String(entry.id), entry);
      if (page.next === undefined) break;
      next = page.next;
    }
  }
  return [...seen.values()];
}

/**
 * The cost of the model responses among `entries` that arrived at or after
 * `since`.
 * @internal
 */
export function spendSince(
  entries: readonly EntryRecord[],
  since: number,
): number {
  let total = 0;
  for (const item of entriesToTranscript(entries)) {
    if (item.kind !== 'assistant' || item.timestamp === undefined) continue;
    if (item.timestamp < since) continue;
    const cost = item.usage?.cost?.total;
    if (typeof cost === 'number' && Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** This machine's spend, in US dollars, since the start of the UTC day. */
export async function spentToday(
  sessionsRoot: string,
  now: number = Date.now(),
): Promise<number> {
  const since = startOfUtcDay(now);
  const files = createNodeFileBridge(sessionsRoot);
  const store = openSessionStore(sessionsRoot, files);
  let total = 0;
  for (const session of await listSessions(store, BACKGROUND_CONTEXT)) {
    const dir = join(sessionsRoot, session.id);
    let touched: number;
    try {
      touched = files.fileInfo(join(dir, 'main.jsonl')).mtimeMs;
    } catch {
      continue;
    }
    if (touched < since || sessionLockIsLive(dir) !== undefined) continue;
    let storage: Storage;
    try {
      storage = await openReadOnlySessionStorage(sessionsRoot, session.id);
    } catch {
      continue;
    }
    try {
      total += spendSince(await allEntries(storage), since);
    } catch {
      // A session that cannot be read adds nothing it could not show.
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  return total;
}

/**
 * One run's spend against the caps: `blocked` refuses a run the day's cap
 * already stops, `add` counts one response and names the stop once a cap is
 * reached.
 */
export class SpendWatch {
  private spent = 0;
  private readonly caps: SpendCaps;
  private readonly today: number;

  constructor(caps: SpendCaps, today: number) {
    this.caps = caps;
    this.today = today;
  }

  get runSpend(): number {
    return this.spent;
  }

  blocked(): string | undefined {
    const daily = this.caps.daily;
    if (daily === undefined || this.today < daily.usd) return undefined;
    return dailyMessage(this.today, daily.usd, daily.layer);
  }

  add(usd: number): string | undefined {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
    const run = this.caps.run;
    if (run !== undefined && this.spent >= run.usd) {
      return `spend limit reached: this run cost ${formatCostUsd(this.spent)}, and [policy] max_run_cost_usd allows ${formatCostUsd(run.usd)} (set by the ${run.layer} layer)`;
    }
    const daily = this.caps.daily;
    if (daily !== undefined && this.today + this.spent >= daily.usd) {
      return dailyMessage(this.today + this.spent, daily.usd, daily.layer);
    }
    return undefined;
  }
}

function dailyMessage(spent: number, cap: number, layer: string): string {
  return `daily spend limit reached: this machine spent ${formatCostUsd(spent)} today (UTC), and [policy] max_daily_cost_usd allows ${formatCostUsd(cap)} (set by the ${layer} layer)`;
}
