// Durable entries as the transcript cells the TUI app renders.
import type { EntryRecord } from '@kubic/agent/pi-boundary';
import type { LaneEntryLike } from '@kubic/tui/lane-cells';

// One durable entry → the coarse transcript cell the TUI app renders. The
// tui package may not import agent types (dep-lint), so the entry is
// projected into the structural `LaneEntryLike` by hand. Message-bearing
// entries render as prompt/assistant/tool cells; a `pi.compaction` summary
// and a `pi.reset` handoff render as their own cells, while the
// positional `pi.system` prompt carries empty content and has none.
export function laneEntryFor(entry: EntryRecord): LaneEntryLike | undefined {
  const role =
    entry.kind === 'pi.user'
      ? 'user'
      : entry.kind === 'pi.assistant'
        ? 'assistant'
        : entry.kind === 'pi.tool-result'
          ? 'toolResult'
          : undefined;
  if (role === undefined) {
    // A compaction summary (or a reset handoff) is part of the
    // session's story — the transcript shows it instead of dropping it. No
    // `branch_summary` entry exists in pi-durable 1.0: branching forks into a
    // new conversation.
    if (entry.kind !== 'pi.compaction' && entry.kind !== 'pi.reset') {
      return undefined;
    }
    const carried = entry.model?.[0] as { content?: unknown } | undefined;
    const content = normalizeMessageContent(carried?.content);
    if (content === undefined) return undefined;
    const data = entry.data as { reason?: unknown } | undefined;
    const reason =
      typeof data?.reason === 'string' && data.reason !== ''
        ? data.reason
        : undefined;
    return {
      id: String(entry.id),
      seq: entry.id,
      type: entry.kind === 'pi.compaction' ? 'compaction' : 'reset',
      message: { role: 'user', content },
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const message = entry.model?.[0] as
    | {
        content?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
        timestamp?: unknown;
        details?: unknown;
      }
    | undefined;
  if (message === undefined) return undefined;
  const content = normalizeMessageContent(message.content);
  if (content === undefined) return undefined;
  return {
    id: String(entry.id),
    // The entry id is pi-durable's monotonic NUMERIC EntryId, which is the
    // transcript order the app sorts by; `seq` stays the numeric field it
    // expects (`String(entry.id)` here would degrade the sort to insertion
    // order).
    seq: entry.id,
    type: 'message',
    message: {
      role,
      content,
      ...(message.isError === true ? { isError: true } : {}),
      ...(typeof message.toolCallId === 'string' && message.toolCallId !== ''
        ? { toolCallId: message.toolCallId }
        : {}),
      // The prompt block's `you · HH:MM:SS`.
      ...(typeof message.timestamp === 'number'
        ? { timestamp: message.timestamp }
        : {}),
      // A file change's display record rides the details.
      ...(message.details === undefined ? {} : { details: message.details }),
    },
  };
}

// A user message's content may be a bare string; the app renders content
// arrays only, so a string becomes its one text part.
function normalizeMessageContent(content: unknown): unknown[] | undefined {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return undefined;
}
