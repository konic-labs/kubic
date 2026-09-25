// Coarse lane-entry cells for the transcript (issue #88).
// §15.2 replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; §15 routes no message
// events, so the transcript is built from the lane's own entries). Pure:
// entries in, cells out, no I/O.
//
// The lane hands entries back newest-first (Pi scans the branch from the
// tip), so cells are ordered by `seq` ascending — the transcript reads
// top-to-bottom as the session happened. Every cell id is derived from the
// entry id plus the part index, so a re-render replaces cells instead of
// duplicating them.

import type { TranscriptEntry, TranscriptEntryKind } from './transcript.js';

// Entry shapes are structural on purpose: the tui package must never import
// worker/host implementation (dep-lint), so only the fields read here are
// typed.
export interface LaneEntryLike {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
}

export const TOOL_RESULT_MAX_CHARS = 400;

const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';
const ROLE_TOOL_RESULT = 'toolResult';

export const PROMPT_PREFIX = '› ';
export const TOOL_CALL_PREFIX = 'tool ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type !== 'text') return undefined;
  return typeof part.text === 'string' ? part.text : undefined;
}

function nameOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type !== 'toolCall') return undefined;
  return typeof part.name === 'string' ? part.name : undefined;
}

function toolCallIdOf(part: unknown, index: number): string {
  if (!isRecord(part)) return String(index);
  return typeof part.id === 'string' && part.id !== ''
    ? part.id
    : String(index);
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TOOL_RESULT_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TOOL_RESULT_MAX_CHARS - 1)}…`;
}

function cellsForEntry(entry: LaneEntryLike): TranscriptEntry[] {
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (id === '') return [];
  if (entry.type !== 'message') return [];
  if (!isRecord(entry.message)) return [];
  const role = entry.message.role;
  if (!Array.isArray(entry.message.content)) return [];
  const parts = entry.message.content as unknown[];
  const cells: TranscriptEntry[] = [];
  const push = (
    key: string,
    kind: TranscriptEntryKind,
    markdown: string,
  ): void => {
    if (markdown === '') return;
    cells.push({ id: `${id}:${key}`, kind, markdown });
  };
  if (role === ROLE_USER) {
    const text = parts
      .map(textOf)
      .filter((t) => t !== undefined)
      .join('\n');
    push('user', 'text', text === '' ? '' : `${PROMPT_PREFIX}${text}`);
    return cells;
  }
  if (role === ROLE_TOOL_RESULT) {
    const text = parts
      .map(textOf)
      .filter((t) => t !== undefined)
      .map(truncate)
      .filter((t) => t !== '')
      .join('\n');
    push('result', 'output', text);
    return cells;
  }
  if (role === ROLE_ASSISTANT) {
    parts.forEach((part, index) => {
      const text = textOf(part);
      if (text !== undefined) {
        push(`text${index === 0 ? '' : `:${index}`}`, 'text', text.trim());
        return;
      }
      const name = nameOf(part);
      if (name !== undefined) {
        push(toolCallIdOf(part, index), 'tool', `${TOOL_CALL_PREFIX}${name}`);
      }
    });
    return cells;
  }
  return cells;
}

export function entriesToCells(
  entries: ReadonlyArray<LaneEntryLike>,
): TranscriptEntry[] {
  const ordered = [...entries].sort((left, right) => {
    const a = typeof left.seq === 'number' ? left.seq : 0;
    const b = typeof right.seq === 'number' ? right.seq : 0;
    return a - b;
  });
  const cells: TranscriptEntry[] = [];
  for (const entry of ordered) {
    for (const cell of cellsForEntry(entry)) cells.push(cell);
  }
  return cells;
}
