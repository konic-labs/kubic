// Kubic's pi-durable transcript adapter.
//
// pi-durable stores typed `EntryRecord`s (`pi.user`, `pi.assistant`
// with `model: [AssistantMessage]`, `pi.tool-result`, `pi.system`,
// `pi.compaction`, `pi.reset`). Every Kubic reader — `kubic sessions attach`,
// `kubic cost`'s run usage, the trajectory, replay/export/eval — reads a
// transcript through THIS module, so the entry-model change lands in one
// place and a reader never matches entry-kind strings on its own.
//
// Two layers:
// - `entriesToTranscript(entries)`: the pure mapping (the CONTRACT seam).
// - `readConversationEntries(conversation)` / `readSessionEntries(storage)`:
//   the two ways a caller gets those entries — from a live harness
//   conversation (the active context) or from a session storage a CLI reader
//   attached to (no model layer, no harness boot, no writes).

import {
  AssistantEntry,
  CompactionEntry,
  type Context,
  type Conversation,
  type EntryRecord,
  ResetEntry,
  type Storage,
  SystemEntry,
  ToolResultEntry,
  type Usage,
  UserEntry,
} from '../pi-boundary.js';
import {
  laneConversationIdOf,
  readSessionMetadata,
} from './session-store/index.js';

export type TranscriptItem =
  | { kind: 'user'; text: string; entryId: string }
  | {
      kind: 'assistant';
      text: string;
      toolCalls: { id: string; name: string; args: unknown }[];
      usage?: Usage;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      entryId: string;
    }
  | {
      kind: 'tool-result';
      callId: string;
      name: string;
      text: string;
      isError: boolean;
      entryId: string;
    }
  | { kind: 'system' | 'compaction' | 'reset'; text?: string; entryId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Text parts of a message's content, in order, one line each. Images are
// not text: they are skipped (a transcript line has no image slot).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text') continue;
    if (typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

// The message payloads one entry contributes, if any. A display or
// bookkeeping entry has none, and contributes no transcript item.
function messagesOf(entry: EntryRecord): readonly Record<string, unknown>[] {
  if (!Array.isArray(entry.model)) return [];
  return entry.model.filter(isRecord);
}

function textOfEntry(entry: EntryRecord): string {
  for (const message of messagesOf(entry)) {
    const text = textOf(message.content);
    if (text !== '') return text;
  }
  return '';
}

function itemFor(entry: EntryRecord): TranscriptItem | undefined {
  const entryId = String(entry.id);
  if (UserEntry.kind === entry.kind) {
    // A message entry: without its message payload there is no turn to
    // show, so it contributes no item.
    if (!messagesOf(entry).some((message) => message.role === 'user')) {
      return undefined;
    }
    return { kind: 'user', text: textOfEntry(entry), entryId };
  }
  if (AssistantEntry.kind === entry.kind) {
    const message = messagesOf(entry).find(
      (candidate) => candidate.role === 'assistant',
    );
    if (message === undefined) return undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    const texts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
      if (part.type === 'toolCall') {
        toolCalls.push({
          id: typeof part.id === 'string' ? part.id : '',
          name: typeof part.name === 'string' ? part.name : 'unknown',
          args: part.arguments,
        });
      }
    }
    const provider =
      typeof message.provider === 'string' ? message.provider : undefined;
    const model = typeof message.model === 'string' ? message.model : undefined;
    const thinkingLevel =
      typeof message.thinkingLevel === 'string'
        ? message.thinkingLevel
        : undefined;
    const usage = isRecord(message.usage)
      ? (message.usage as unknown as Usage)
      : undefined;
    return {
      kind: 'assistant',
      text: texts.join('\n'),
      toolCalls,
      ...(usage === undefined ? {} : { usage }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      entryId,
    };
  }
  if (ToolResultEntry.kind === entry.kind) {
    const message = messagesOf(entry).find(
      (candidate) => candidate.role === 'toolResult',
    );
    if (message === undefined) return undefined;
    return {
      kind: 'tool-result',
      callId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
      name: typeof message.toolName === 'string' ? message.toolName : 'unknown',
      text: textOf(message.content),
      isError: message.isError === true,
      entryId,
    };
  }
  if (SystemEntry.kind === entry.kind) {
    const text = textOfEntry(entry);
    return { kind: 'system', ...(text === '' ? {} : { text }), entryId };
  }
  if (CompactionEntry.kind === entry.kind) {
    const text = textOfEntry(entry);
    return { kind: 'compaction', ...(text === '' ? {} : { text }), entryId };
  }
  if (ResetEntry.kind === entry.kind) {
    // A plain reset carries no handoff message; one with a handoff carries
    // it as a user message.
    const text = textOfEntry(entry);
    return { kind: 'reset', ...(text === '' ? {} : { text }), entryId };
  }
  // Not a transcript kind (an extension's own entry, bookkeeping): the
  // adapter never guesses an item for it.
  return undefined;
}

// Map durable entries to transcript items, in transcript order. Callers may
// hand entries in any order (storage scans are newest-first): entry ids are
// assigned in commit order, so sorting by id restores the order the session
// happened in. Unknown kinds are skipped.
export function entriesToTranscript(
  entries: readonly EntryRecord[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of [...entries].sort((left, right) => left.id - right.id)) {
    const item = itemFor(entry);
    if (item !== undefined) items.push(item);
  }
  return items;
}

// The active transcript of one conversation, from a live harness: the
// context view's entries (the newest head marker followed by the entries it
// keeps, in transcript order). The trajectory capture reads this while the
// lane is still open.
export async function readConversationEntries(
  conversation: Conversation,
  context: Context,
): Promise<EntryRecord[]> {
  const view = await conversation.context(context);
  return [...view.entries];
}

// Page size for the storage scan: bounded reads, no unbounded query.
const ENTRY_PAGE = 256;

// The active transcript of a session's root conversation, read straight from
// a pi-durable Storage — the path every CLI reader takes (`kubic sessions
// attach`, `kubic cost`'s run usage). No Harness and no model layer are
// booted and nothing is written: a reader must be able to inspect a session
// it is not allowed to run.
export async function readSessionEntries(
  storage: Storage,
  context: Context,
): Promise<EntryRecord[]> {
  // The lane conversation — a fork's recorded one, else the
  // root. A session that never ran has no root conversation yet: no
  // transcript, and never a throw (a reader must not invent one).
  const laneId = laneConversationIdOf(
    await readSessionMetadata(storage, context),
  );
  const conversation = await storage.conversation(laneId, context);
  if (conversation === undefined) return [];
  // The newest entry that starts a context (a compaction or reset) is the
  // range's lower bound; without one, the conversation's whole visible
  // history. Scans are newest-first, so the result is reversed at the end.
  const marker = await storage.findLatestHeadMarker(laneId, undefined, context);
  const minEntryId = marker?.head;
  const entries: EntryRecord[] = [];
  let cursor: Awaited<ReturnType<Storage['scanEntries']>>['next'];
  for (;;) {
    const page = await storage.scanEntries(
      {
        conversationId: laneId,
        ...(minEntryId === undefined ? {} : { minEntryId }),
      },
      ENTRY_PAGE,
      cursor,
      context,
    );
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return entries.reverse();
}
