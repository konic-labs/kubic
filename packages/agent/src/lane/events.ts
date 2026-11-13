// Lane event consumer on pi-durable's conversation view. Exactly one
// subscription per conversation relays the groups Kubic routes — run status,
// tool status, usage, faults — plus the retry and compaction state the
// harness keeps in `pi.live`, the inbox queue the TUI renders and the
// in-flight generation's text. Everything else (thinking, navigation, config)
// stays inside Pi: Kubic defines no parallel event vocabulary.
//
// Pi renders state rather than streaming events: `Conversation.watch()`
// delivers the conversation view (a window over the transcript plus the
// conversation's documents), and this module turns each change of that view
// into `KubicLaneEvent`s, so every Kubic consumer keeps one vocabulary. The
// watch is bound to one conversation, so another conversation's state can
// never reach the sink. The snapshot is the late-join path: it is delivered
// at subscription and again when the view's window moved past entries the
// sink never saw, and it means REPLACE, not append.

import type {
  CommitPublication,
  CompactionStatus,
  Context,
  Conversation,
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  Harness,
  InboxState,
  JsonObject,
  LiveState,
  SubmissionId,
  TaskId,
  ToolSlot,
  UsageState,
} from '../pi-boundary.js';
import { InboxDoc, LiveDoc, UsageDoc } from '../pi-boundary.js';
import { type KubicUsageRow, usageRowFromEntry } from '../usage.js';

// One tool call of a snapshot: the live slot plus, once done, the result
// entry that carries the transcript cell.
interface KubicLaneTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'pending' | 'running' | 'done';
  readonly isError: boolean;
  readonly entry?: EntryRecord;
}

// One live compaction of a snapshot.
interface KubicLaneCompaction {
  readonly taskId: TaskId;
  readonly reason: string;
  readonly blocking: boolean;
  readonly attempt: number;
  readonly error?: string;
}

// One queued submission of the conversation's inbox: the id and the
// mode (`followUp` / `steer`, or a passive `write`). The text is the
// submitter's own, so a renderer keys its own prompt text by id and drops
// the row when the id leaves.
export interface KubicInboxItem {
  readonly id: string;
  readonly mode: 'steer' | 'followUp' | 'write';
}

export type KubicLaneEvent =
  | { type: 'run-start'; inputs: readonly SubmissionId[] }
  | { type: 'run-end'; inputs: readonly SubmissionId[] }
  | {
      type: 'tool-start';
      toolCallId: string;
      toolName: string;
      args: JsonObject;
    }
  | {
      type: 'tool-end';
      toolCallId: string;
      toolName: string;
      // Pi reports no result entry for a faulted or orphaned tool task;
      // that is the error signal the tree shows.
      isError: boolean;
      entry?: EntryRecord;
    }
  | {
      // The running generation's text, appended as it streams.
      // The partial is not committed yet, so there is no entry to name; the
      // consumer renders it as a draft and the committed entry replaces it.
      // Only text is routed — thinking stays Pi's.
      type: 'message-delta';
      text: string;
    }
  | {
      type: 'usage';
      // The committed assistant response, labelled with the provider/model
      // that answered; `entry` carries its transcript cell.
      row: KubicUsageRow;
      entry: EntryRecord;
    }
  | {
      // A committed entry that carries no assistant response —
      // a user turn, a compaction summary, a reset handoff. The transcript
      // folds it live instead of waiting for the next full read.
      type: 'entry';
      entry: EntryRecord;
    }
  | {
      type: 'inbox';
      // The inbox as of this change: admission, placement and withdrawal all
      // emit it, so the list is a snapshot, never a delta.
      items: readonly KubicInboxItem[];
    }
  | { type: 'fault'; code: string; message: string }
  | {
      type: 'retry';
      phase: 'start' | 'end';
      attempt?: number;
      error?: string;
    }
  | { type: 'compaction'; phase: 'start' | 'end'; reason?: string }
  | {
      type: 'snapshot';
      // Committed transcript at the snapshot. REPLACE the sink's cells.
      entries: readonly EntryRecord[];
      run?: readonly SubmissionId[];
      tools: readonly KubicLaneTool[];
      retry?: { attempt: number; error: string };
      compactions: readonly KubicLaneCompaction[];
      usage: UsageState;
    };

export type LaneEventSink = (event: KubicLaneEvent) => void;

// The documents of a view the events read.
interface ViewParts {
  readonly live: LiveState;
  readonly inbox: InboxState | undefined;
  readonly usage: UsageState;
}

function partsOf(view: ConversationView): ViewParts {
  return {
    live: (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState,
    inbox: view.docs[InboxDoc.definition.kind] as InboxState | undefined,
    usage:
      (view.docs[UsageDoc.definition.kind] as UsageState | undefined) ??
      UsageDoc.definition.initial(),
  };
}

function findEntry(
  lists: readonly (readonly EntryRecord[])[],
  id: EntryId | undefined,
): EntryRecord | undefined {
  if (id === undefined) return undefined;
  for (const list of lists) {
    const found = list.find((entry) => entry.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// A tool result is an error when Pi wrote none (a faulted or orphaned task)
// or when the result says so.
function resultIsError(entry: EntryRecord | undefined): boolean {
  const message = entry?.model?.[0];
  return (
    entry === undefined ||
    (message?.role === 'toolResult' && message.isError === true)
  );
}

function toolOf(
  slot: ToolSlot,
  lists: readonly (readonly EntryRecord[])[],
): KubicLaneTool {
  const entry = findEntry(lists, slot.entry);
  return {
    toolCallId: slot.callId,
    toolName: slot.name,
    status: slot.status,
    isError: slot.status === 'done' && resultIsError(entry),
    ...(entry === undefined ? {} : { entry }),
  };
}

function compactionOf(status: CompactionStatus): KubicLaneCompaction {
  return {
    taskId: status.taskId,
    reason: status.trigger,
    blocking: status.blocking,
    attempt: status.attempt,
    ...(status.retry === undefined ? {} : { error: status.retry.error }),
  };
}

// The snapshot of a view: `entries` is the active transcript at the view
// (what the model sees), read by the caller; the view's own entries are a
// window over the whole history.
/** @internal */
export function snapshotOf(
  view: ConversationView,
  entries: readonly EntryRecord[],
): KubicLaneEvent {
  const { live, usage } = partsOf(view);
  const generation = live.generation;
  return {
    type: 'snapshot',
    entries,
    ...(live.run === undefined ? {} : { run: live.run.inputs }),
    tools: (live.tools ?? []).map((slot) =>
      toolOf(slot, [entries, view.entries]),
    ),
    ...(generation?.retry === undefined
      ? {}
      : {
          retry: {
            attempt: generation.attempt,
            error: generation.retry.error,
          },
        }),
    compactions: (live.compactions ?? []).map(compactionOf),
    usage,
  };
}

// The streamed text of the in-flight generation, thinking left out.
function draftText(live: LiveState): string | undefined {
  const message = live.generation?.message;
  if (message === undefined) return undefined;
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

// The arguments of a tool call, from the assistant entry that made it (the
// newest one naming the call id).
function argsOf(entries: readonly EntryRecord[], callId: string): JsonObject {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.model?.[0];
    if (message?.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.id === callId) {
        return block.arguments as JsonObject;
      }
    }
  }
  return {};
}

function inboxItems(inbox: InboxState | undefined): KubicInboxItem[] {
  return (inbox?.items ?? []).map((item) => ({
    id: String(item.id),
    mode: item.mode,
  }));
}

function sameInbox(
  a: readonly KubicInboxItem[],
  b: readonly KubicInboxItem[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return other?.id === item.id && other.mode === item.mode;
    })
  );
}

// The newest entry id of a view, the mark later entries are appended after.
function newestId(view: ConversationView): EntryId | undefined {
  return view.entries.at(-1)?.id;
}

// The entries committed after `mark`, in transcript order.
function appendedSince(
  view: ConversationView,
  mark: EntryId | undefined,
): EntryRecord[] {
  return mark === undefined
    ? [...view.entries]
    : view.entries.filter((entry) => entry.id > mark);
}

// The committed-entry event of one entry: an assistant response is a usage
// row; an entry without a model message (a marker) carries nothing to render.
function entryEvent(entry: EntryRecord): KubicLaneEvent | undefined {
  if (entry.model?.[0] === undefined) return undefined;
  const row = usageRowFromEntry(entry);
  return row === undefined
    ? { type: 'entry', entry }
    : { type: 'usage', row, entry };
}

type ToolEnd = Extract<KubicLaneEvent, { type: 'tool-end' }>;

// Tools that ended between the two views: a slot that became done, one
// created done (a call the request did not offer), or an unfinished one that
// vanished because its run ended. A done slot that vanishes ended earlier.
function toolEnds(
  was: LiveState,
  now: LiveState,
  appended: readonly EntryRecord[],
  view: ConversationView,
): ToolEnd[] {
  const before = new Map((was.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.tools ?? [];
  const ends: ToolEnd[] = [];
  const end = (slot: ToolSlot, entry: EntryRecord | undefined): void => {
    ends.push({
      type: 'tool-end',
      toolCallId: slot.callId,
      toolName: slot.name,
      isError: resultIsError(entry),
      ...(entry === undefined ? {} : { entry }),
    });
  };
  for (const previous of before.values()) {
    if (previous.status === 'done') continue;
    const slot = slots.find(
      (candidate) => candidate.callId === previous.callId,
    );
    if (slot?.status === 'done') {
      end(slot, findEntry([appended, view.entries], slot.entry));
    } else if (slot === undefined) {
      const result = appended.find((entry) => {
        const message = entry.model?.[0];
        return (
          message?.role === 'toolResult' &&
          message.toolCallId === previous.callId
        );
      });
      end(previous, result);
    }
  }
  for (const slot of slots) {
    if (slot.status === 'done' && !before.has(slot.callId)) {
      end(slot, findEntry([appended, view.entries], slot.entry));
    }
  }
  return ends;
}

// Progress that began between the two views: tool starts, the in-flight
// text that continues the previous draft, and retry state.
function progressEvents(
  was: LiveState,
  now: LiveState,
  view: ConversationView,
  continued: string | undefined,
): KubicLaneEvent[] {
  const events: KubicLaneEvent[] = [];
  const before = new Map((was.tools ?? []).map((slot) => [slot.callId, slot]));
  for (const slot of now.tools ?? []) {
    if (slot.status !== 'running') continue;
    if (before.get(slot.callId)?.status === 'running') continue;
    events.push({
      type: 'tool-start',
      toolCallId: slot.callId,
      toolName: slot.name,
      args: argsOf(view.entries, slot.callId),
    });
  }
  if (continued !== undefined && continued !== '') {
    events.push({ type: 'message-delta', text: continued });
  }
  const generation = now.generation;
  const generationBefore = was.generation;
  if (
    generation?.retry !== undefined &&
    generationBefore?.retry === undefined
  ) {
    events.push({
      type: 'retry',
      phase: 'start',
      attempt: generation.attempt,
      error: generation.retry.error,
    });
  }
  if (
    generationBefore?.retry !== undefined &&
    generation?.retry === undefined
  ) {
    events.push({
      type: 'retry',
      phase: 'end',
      attempt: generationBefore.attempt,
    });
  }
  return events;
}

// The draft text between two views: the part that continues the previous
// draft (rendered before the entries) or a new draft (rendered after them,
// once the entry that ended the previous one is in).
function draftChange(
  was: LiveState,
  now: LiveState,
): { continued?: string; started?: string } {
  const text = draftText(now);
  if (text === undefined) return {};
  const previous = draftText(was);
  if (previous !== undefined && text.startsWith(previous)) {
    return { continued: text.slice(previous.length) };
  }
  return { started: text };
}

// Every event one change of the view causes, in order: progress, then the
// committed entries (a tool's end directly before its result entry), then
// compaction ends, the run end, the inbox, compaction starts and the run
// start.
/** @internal */
export function laneEventsBetween(
  before: ConversationView,
  after: ConversationView,
): KubicLaneEvent[] {
  const was = partsOf(before);
  const now = partsOf(after);
  const appended = appendedSince(after, newestId(before));
  const draft = draftChange(was.live, now.live);
  const events = progressEvents(was.live, now.live, after, draft.continued);

  const ends = toolEnds(was.live, now.live, appended, after);
  for (const entry of appended) {
    events.push(...ends.filter((end) => end.entry?.id === entry.id));
    const event = entryEvent(entry);
    if (event !== undefined) events.push(event);
  }
  const appendedIds = new Set(appended.map((entry) => entry.id));
  events.push(
    ...ends.filter(
      (end) => end.entry === undefined || !appendedIds.has(end.entry.id),
    ),
  );
  if (draft.started !== undefined && draft.started !== '') {
    events.push({ type: 'message-delta', text: draft.started });
  }

  const compactionsBefore = was.live.compactions ?? [];
  const compactions = now.live.compactions ?? [];
  for (const status of compactionsBefore) {
    if (!compactions.some((other) => other.taskId === status.taskId)) {
      events.push({ type: 'compaction', phase: 'end', reason: status.trigger });
    }
  }
  const run = now.live.run;
  const runBefore = was.live.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
  if (runBefore !== undefined && runChanged) {
    events.push({ type: 'run-end', inputs: runBefore.inputs });
  }
  const items = inboxItems(now.inbox);
  if (!sameInbox(inboxItems(was.inbox), items)) {
    events.push({ type: 'inbox', items });
  }
  for (const status of compactions) {
    if (!compactionsBefore.some((other) => other.taskId === status.taskId)) {
      events.push({
        type: 'compaction',
        phase: 'start',
        reason: status.trigger,
      });
    }
  }
  if (run !== undefined && runChanged) {
    events.push({ type: 'run-start', inputs: run.inputs });
  }
  return events;
}

// The faults of one stored commit: a task of this conversation that ended
// faulted or orphaned. The view keeps no record of them, so they come from
// the commits.
/** @internal */
export function faultsOf(
  publication: CommitPublication,
  conversationId: ConversationId,
): KubicLaneEvent[] {
  const faults: KubicLaneEvent[] = [];
  for (const change of publication.changes) {
    if (change.type !== 'task') continue;
    const task = change.value;
    if (task.conversationId !== conversationId) continue;
    if (task.state.status !== 'terminal') continue;
    const outcome = task.state.outcome;
    if (outcome.status === 'faulted') {
      faults.push({
        type: 'fault',
        code: task.kind,
        message: outcome.error.message,
      });
    } else if (outcome.status === 'orphaned') {
      faults.push({ type: 'fault', code: task.kind, message: outcome.reason });
    }
  }
  return faults;
}

// Whether the window of `next` starts past the newest entry the sink saw in
// `before`: entries were committed and dropped from the window before the
// sink saw them.
/** @internal */
export function windowSkipped(
  before: ConversationView,
  next: ConversationView,
): boolean {
  const seen = newestId(before);
  return next.before !== undefined && seen !== undefined && next.before > seen;
}

// The active transcript as of a view: the context at the view's newest
// entry, so the snapshot and the changes that follow it line up.
async function transcriptAt(
  conversation: Conversation,
  view: ConversationView,
  context: Context,
): Promise<readonly EntryRecord[]> {
  const at = newestId(view);
  const read = await conversation.context(
    context,
    at === undefined ? undefined : { at },
  );
  return read.entries;
}

// The single event subscription for one conversation. The attachment
// snapshot is delivered through the sink first (late join), then every
// change of the view in order, so nothing between the snapshot and the
// listener's activation can be lost. The returned stop is idempotent.
export async function subscribeLaneEvents(
  harness: Harness,
  conversationId: ConversationId,
  sink: LaneEventSink,
  context: Context,
): Promise<() => Promise<void>> {
  const conversation = await harness.conversation(conversationId, context);
  if (conversation === undefined) {
    throw new Error(`conversation ${conversationId} is missing`);
  }
  const watch = await conversation.watch(context);
  let current = watch.value;
  sink(snapshotOf(current, await transcriptAt(conversation, current, context)));
  const faults = harness.observeCommits({
    advance: (publication) => {
      for (const fault of faultsOf(publication, conversationId)) sink(fault);
    },
    end: () => {},
  });
  watch.start(async (call) => {
    if (call.kind !== 'value') return;
    const next = call.value;
    const before = current;
    current = next;
    // The window moved past entries the sink never saw: rebase on a fresh
    // snapshot instead of leaving a hole in the transcript.
    if (windowSkipped(before, next)) {
      sink(snapshotOf(next, await transcriptAt(conversation, next, context)));
      return;
    }
    for (const event of laneEventsBetween(before, next)) sink(event);
  });
  let stopped: Promise<void> | undefined;
  return () => {
    stopped ??= (async () => {
      faults.detach();
      await watch.stop();
    })();
    return stopped;
  };
}
