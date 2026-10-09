// The transcript's vocabulary: an entry (one cell) and its display record,
// the blocks block mode selects, the per-turn receipt, and the deltas a lane
// streams. Lane cells produce them; the transcript renders them.

import type { LaneImagePart } from '@kubic/core/presentation';

// 'prompt' is the operator's own line; 'text' is assistant prose (rendered
// as markdown); 'tool' is a call; 'output' is a call's result.
export type TranscriptEntryKind =
  | 'prompt'
  | 'text'
  | 'tool'
  | 'output'
  // A compaction summary the lane placed in the branch.
  | 'compaction'
  // The model's reasoning (Pi ThinkingContent), collapsed.
  | 'thinking'
  // A settled turn's one-line receipt (UI only, never stored).
  | 'receipt';

// What block mode walks and copies — one block per prompt,
// answer, thinking, tool card, compaction and receipt, as last drawn.
export type TranscriptBlockKind =
  | 'prompt'
  | 'prose'
  | 'thinking'
  | 'tool'
  | 'compaction'
  | 'receipt';

export interface TranscriptBlock {
  readonly id: string;
  readonly kind: TranscriptBlockKind;
  /** The block's first row in the document, and how many rows it takes. */
  readonly firstRow: number;
  readonly rowCount: number;
  /** What `y` copies: a tool's output, an answer's markdown, a prompt. */
  readonly copyText: string;
  /** What `Y` copies: a tool's command; otherwise the same as copyText. */
  readonly metaText: string;
}

// What a settled turn did — the receipt cell's data.
export interface TurnReceipt {
  readonly outcome: 'completed' | 'cancelled' | 'failed';
  readonly elapsedMs: number;
  readonly tools: number;
  readonly files: number;
  readonly added?: number;
  readonly removed?: number;
  readonly costUsd: number;
  /** The failure's own text (first line). */
  readonly detail?: string;
  /** The diff panel key's cap (`^O`); empty hides the hint. */
  readonly diffKey?: string;
}

// A file change's display record (the inline diff, or a new
// file's size and first lines) — a structural mirror of the agent's
// ToolDisplay (dep-lint forbids tui → agent), sanitized at ingress.
export type CellDisplay =
  | {
      readonly kind: 'diff';
      readonly text: string;
      readonly firstChangedLine: number;
      readonly added: number;
      readonly removed: number;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'write';
      readonly newFile: boolean;
      readonly lines: number;
      readonly preview: string;
    };

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly markdown: string;
  // Tool calls: a one-line argument summary (path, command, …).
  readonly detail?: string;
  // Tool outputs: the call failed.
  readonly isError?: boolean;
  // Pairs a call with its output so the output renders under the call.
  readonly toolCallId?: string;
  // Images attached to this prompt. Rendered under the
  // prompt text as the real image or the terminal placeholder.
  readonly images?: readonly LaneImagePart[];
  // When the entry was committed (ms since the epoch) — the
  // prompt block's `you · HH:MM:SS`.
  readonly timestamp?: number;
  // A tool output's display record (edit/write).
  readonly display?: CellDisplay;
  // A thinking cell's measured generation time.
  readonly durationMs?: number;
  // A receipt cell's data.
  readonly receipt?: TurnReceipt;
}

export function displayKey(display: CellDisplay | undefined): string {
  if (display === undefined) return '';
  return display.kind === 'diff'
    ? `d\u0000${display.added}\u0000${display.removed}\u0000${display.text}`
    : `w\u0000${display.newFile}\u0000${display.lines}\u0000${display.preview}`;
}

export interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

// The transcript only needs the lane's identity: the presentation state shape
// (presentation.ts) is the projector's business, and requiring all of it here
// would make every cell-application carry fields it never reads.
export interface LaneIdentity {
  readonly laneId: string;
}

// Collapsed tool output shows this many lines; Ctrl-X expands every block.
export const TOOL_OUTPUT_PREVIEW_LINES = 5;

// What the composition root knows about a call that the
// committed entries do not say — how long it took (or has been running) and
// whether an approval holds it.
export interface ToolCallState {
  readonly durationMs?: number;
  readonly runningMs?: number;
  readonly waiting?: boolean;
}
