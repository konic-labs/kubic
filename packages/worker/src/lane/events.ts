// Solo-lane event consumer on pi-durable's committed watch. Exactly one
// subscription per conversation relays the groups Kubic routes — run status,
// tool status, usage, faults — plus the retry and compaction state the 1.0
// harness commits, the inbox queue the TUI renders and the in-flight
// generation's text deltas. Everything else (thinking deltas, navigation,
// config) stays inside Pi: Kubic defines no parallel event vocabulary.
//
// `watchEvents` is experimental upstream, so it is isolated here: every
// Kubic consumer sees `KubicLaneEvent`, and `viewState()` (`pi.live`) can
// replace the watch without touching a sink. The watch is bound to one
// conversation, so another conversation's events can never reach the
// sink. The snapshot is the late-join path: it is delivered at
// subscription and again when a fallen-behind consumer overflows the
// watch's pending bound (>100 batches), and it means REPLACE, not append.

import type {
  AgentEvent,
  Context,
  ConversationId,
  EntryId,
  EntryRecord,
  Harness,
  JsonObject,
  SnapshotEvent,
  SubmissionId,
  TaskId,
  UsageState,
} from '../pi-boundary.js';
import { watchEvents } from '../pi-boundary.js';
import { type KubicUsageRow, usageRowFromEntry } from '../usage.js';

// One tool call of a snapshot: the live slot plus, once done, the result
// entry that carries the transcript cell.
export interface KubicLaneTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'pending' | 'running' | 'done';
  readonly isError: boolean;
  readonly entry?: EntryRecord;
}

// One live compaction of a snapshot.
export interface KubicLaneCompaction {
  readonly taskId: TaskId;
  readonly reason: string;
  readonly blocking: boolean;
  readonly attempt: number;
  readonly error?: string;
}

// One queued submission of the conversation's inbox: the id and the
// mode (`followUp` / `steer`, or a passive `write`). The text is the
// submitter's own — the inbox document carries no content — so a renderer
// keys its own prompt text by id and drops the row when the id leaves.
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
      // consumer renders it as a draft and the committed `message_end` entry
      // replaces it. Only text deltas are routed — thinking stays Pi's.
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
      // The inbox as of this commit: admission, placement and withdrawal all
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

function entryOf(
  snapshot: SnapshotEvent,
  id: EntryId | undefined,
): EntryRecord | undefined {
  return id === undefined
    ? undefined
    : snapshot.entries.find((entry) => entry.id === id);
}

function toolOf(
  snapshot: SnapshotEvent,
  slot: SnapshotEvent['tools'][number],
): KubicLaneTool {
  const entry = entryOf(snapshot, slot.entry);
  const message = entry?.model?.[0];
  const isError =
    slot.status === 'done' &&
    (entry === undefined ||
      (message?.role === 'toolResult' && message.isError));
  return {
    toolCallId: slot.callId,
    toolName: slot.name,
    status: slot.status,
    isError,
    ...(entry === undefined ? {} : { entry }),
  };
}

function compactionOf(
  status: SnapshotEvent['compactions'][number],
): KubicLaneCompaction {
  return {
    taskId: status.taskId,
    reason: status.reason,
    blocking: status.blocking,
    attempt: status.attempt,
    ...(status.retry === undefined ? {} : { error: status.retry.error }),
  };
}

function snapshotEvent(snapshot: SnapshotEvent): KubicLaneEvent {
  const generation = snapshot.generation;
  return {
    type: 'snapshot',
    entries: snapshot.entries,
    ...(snapshot.run === undefined ? {} : { run: snapshot.run.inputs }),
    tools: snapshot.tools.map((slot) => toolOf(snapshot, slot)),
    ...(generation?.retry === undefined
      ? {}
      : {
          retry: {
            attempt: generation.attempt,
            error: generation.retry.error,
          },
        }),
    compactions: snapshot.compactions.map(compactionOf),
    usage: snapshot.usage,
  };
}

// One pi-durable agent event in Kubic's vocabulary; undefined for the
// kinds Kubic does not route (message deltas, inbox, deferred polls — a
// deferred turn is surfaced by the submission).
export function toKubicLaneEvent(
  event: AgentEvent,
): KubicLaneEvent | undefined {
  switch (event.type) {
    case 'snapshot': {
      return snapshotEvent(event);
    }
    case 'run_start': {
      return { type: 'run-start', inputs: event.inputs };
    }
    case 'run_end': {
      return { type: 'run-end', inputs: event.inputs };
    }
    case 'tool_execution_start': {
      return {
        type: 'tool-start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    }
    case 'tool_execution_end': {
      const message = event.entry?.model?.[0];
      const isError =
        event.entry === undefined ||
        (message?.role === 'toolResult' && message.isError);
      return {
        type: 'tool-end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError,
        ...(event.entry === undefined ? {} : { entry: event.entry }),
      };
    }
    case 'message_update': {
      // The streamed text of the in-flight generation (deltas render as they
      // arrive). A whole-message change or a thinking delta carries no text for
      // the transcript, so it maps to nothing.
      const text = event.changes
        .map((change) => (change.type === 'text_delta' ? change.delta : ''))
        .join('');
      return text === '' ? undefined : { type: 'message-delta', text };
    }
    case 'message_end': {
      const row = usageRowFromEntry(event.entry);
      return row === undefined
        ? { type: 'entry', entry: event.entry }
        : { type: 'usage', row, entry: event.entry };
    }
    case 'inbox_update': {
      return {
        type: 'inbox',
        items: event.items.map((item) => ({
          id: String(item.id),
          mode: item.mode,
        })),
      };
    }
    case 'auto_retry_start': {
      return {
        type: 'retry',
        phase: 'start',
        attempt: event.attempt,
        error: event.errorMessage,
      };
    }
    case 'auto_retry_end': {
      return { type: 'retry', phase: 'end', attempt: event.attempt };
    }
    case 'compaction_start': {
      return { type: 'compaction', phase: 'start', reason: event.reason };
    }
    case 'compaction_end': {
      return { type: 'compaction', phase: 'end', reason: event.reason };
    }
    case 'task_failed': {
      return { type: 'fault', code: event.kind, message: event.message };
    }
    default: {
      return undefined;
    }
  }
}

// The single event subscription for one conversation. The attachment
// snapshot is delivered through the sink first (late join), then every
// commit's batch in order, so no event between the snapshot and the
// listener's activation can be lost. The returned stop is idempotent.
export async function subscribeLaneEvents(
  harness: Harness,
  conversationId: ConversationId,
  sink: LaneEventSink,
  context: Context,
): Promise<() => Promise<void>> {
  const stream = await watchEvents(harness, conversationId, context);
  const initial = toKubicLaneEvent(stream.snapshot);
  if (initial !== undefined) sink(initial);
  stream.start(async (events) => {
    for (const event of events) {
      const mapped = toKubicLaneEvent(event);
      if (mapped !== undefined) sink(mapped);
    }
  });
  return async () => {
    await stream.stop();
  };
}
