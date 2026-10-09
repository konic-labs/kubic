// The transcript: the session's committed lane entries as cells (prompts,
// prose, tool cards, thinking, compactions and per-turn receipts), followed by
// the draft of the message still streaming. The ScrollView owns scrolling (it
// follows the end until the user scrolls away); this module owns the
// document. Each cell's markdown and finished rows are cached while its text,
// width and theme are unchanged, so a steady frame parses nothing.

import type { LaneImagePart } from '@kubic/core/presentation';
import { sanitizeLaneText } from './lane-text.js';
import { TranscriptDocument } from './transcript-document.js';
import type {
  LaneIdentity,
  ToolCallState,
  TranscriptBlock,
  TranscriptDelta,
  TranscriptEntry,
} from './transcript-entry.js';
import { displayKey } from './transcript-entry.js';
import type { Component } from './tui-boundary.js';
import { ScrollView } from './tui-boundary.js';

interface TranscriptSnapshotOp {
  readonly op: 'snapshot';
  readonly laneId: string;
  readonly cells: ReadonlyArray<TranscriptEntry>;
  readonly revision: number;
}

interface TranscriptDeltaOp {
  readonly op: 'delta';
  readonly delta: TranscriptDelta;
}

type TranscriptOp = TranscriptSnapshotOp | TranscriptDeltaOp;

export interface TranscriptView {
  readonly component: Component;
  readonly scroll: ScrollView;
  readonly rebuilds: number;
  readonly isPinned: boolean;
  readonly scrollTop: number;
  readonly writeLog: ReadonlyArray<TranscriptOp>;
  appendDelta(delta: TranscriptDelta): void;
  applyLaneSnapshot(
    lane: LaneIdentity,
    cells: ReadonlyArray<TranscriptEntry>,
    revision: number,
  ): void;
  updateLayout(contentHeight: number, viewportHeight: number): void;
  scrollUp(lines: number): void;
  rePin(): void;
  render(width: number): string[];
  // The welcome block at the top of the document, the prompt echoed before
  // the lane commits it, and the expand-all toggle.
  setWelcome(
    lines: ReadonlyArray<string> | ((width: number) => string[]),
  ): void;
  setPendingPrompt(
    prompt: string | undefined,
    images?: readonly LaneImagePart[],
  ): void;
  // The streamed draft of the in-flight generation (undefined
  // clears it). The committed entry replaces it.
  setStream(text: string | undefined): void;
  // The queued follow-ups (`pi.inbox`), newest last. A fresh
  // call REPLACES the rows — the inbox event is a snapshot, not a delta.
  setQueuedPrompts(prompts: readonly string[]): void;
  toggleExpanded(): boolean;
  readonly expanded: boolean;
  // Block mode — the blocks of the last render, the selection
  // (drawn with an accent edge), one block's expand toggle, one block whole
  // for the viewer, and scrolling a block into view.
  blocks(): readonly TranscriptBlock[];
  select(id: string | undefined): void;
  toggleBlock(id: string): boolean;
  blockLines(id: string, width: number): string[];
  reveal(id: string): void;
  // Cache counters the perf tests assert on — the live markdown
  // entries and how many parses (constructor + setText) the document forced.
  markdownCacheSize(): number;
  markdownParses(): number;
  // The live cell objects (a copy of the ARRAY; the objects are
  // the live ones). Tests pin that an identical snapshot preserves identity.
  liveCells(): ReadonlyArray<TranscriptEntry>;
}

export interface TranscriptViewOptions {
  // Replaces the whole document while it returns lines (the approval's
  // inline fallback below the overlay's minimum width).
  readonly inline?: (width: number) => string[] | undefined;
  // The op log is OPT-IN. It exists for `replayTranscript` and
  // the tests that drive it; production applies a snapshot on every lane
  // event, so an always-on log retained a deep copy of every one (O(N·E)
  // cells, tool outputs up to 20k chars). Absent means no log at all.
  readonly ops?: boolean;
  // Per-call facts (duration, running clock, waiting on an
  // approval) and the expand key's cap for the card footers.
  readonly toolState?: (toolCallId: string) => ToolCallState | undefined;
  readonly expandKey?: () => string;
  // Resolves a project path to its `file://` URL.
  readonly fileUrl?: (path: string) => string | undefined;
}

// Two cells are the same entry when every field the transcript
// renders matches — then a re-applied snapshot can keep the live object.
function sameCell(left: TranscriptEntry, right: TranscriptEntry): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.markdown === right.markdown &&
    left.detail === right.detail &&
    left.isError === right.isError &&
    left.toolCallId === right.toolCallId &&
    left.timestamp === right.timestamp &&
    displayKey(left.display) === displayKey(right.display) &&
    left.durationMs === right.durationMs &&
    left.receipt === right.receipt
  );
}

// A snapshot's cells, keeping the object of every unchanged cell (by id).
// The TUI applies a snapshot per lane event, so copying every cell each
// time allocated the whole document per event (and invalidated the
// render caches keyed on the object's text).
function reuseUnchanged(
  cells: ReadonlyArray<TranscriptEntry>,
  byId: ReadonlyMap<string, TranscriptEntry>,
): TranscriptEntry[] {
  return cells.map((cell) => {
    const previous = byId.get(cell.id);
    return previous !== undefined && sameCell(previous, cell)
      ? previous
      : { ...cell };
  });
}

export function createTranscriptView(
  options: TranscriptViewOptions = {},
): TranscriptView {
  const document = new TranscriptDocument();
  document.inline = options.inline;
  document.toolState = options.toolState;
  document.expandKey = options.expandKey;
  document.fileUrl = options.fileUrl;
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  });
  const entries: TranscriptEntry[] = [];
  // The live object per id: a re-applied snapshot reuses it, and the
  // delta path mutates it in place.
  const byId = new Map<string, TranscriptEntry>();
  const logOps = options.ops === true;
  let rebuilds = 0;
  let laneId: string | undefined;
  let revision = -1;
  const log: TranscriptOp[] = [];
  const paint = (): void => {
    // Through setCells, so a cell that left the snapshot also
    // leaves the markdown/line caches. Only the ARRAY is copied
    // (cheap references) — the cell objects themselves are reused.
    document.setCells(entries.slice());
    rebuilds += 1;
  };
  return {
    component: scroll,
    scroll,
    get rebuilds(): number {
      return rebuilds;
    },
    get isPinned(): boolean {
      return scroll.isFollowingEnd;
    },
    get scrollTop(): number {
      return scroll.scrollTop;
    },
    get writeLog(): ReadonlyArray<TranscriptOp> {
      return log;
    },
    updateLayout(contentHeight: number, viewportHeight: number): void {
      scroll.updateLayout(contentHeight, viewportHeight, () => {});
    },
    scrollUp(lines: number): void {
      scroll.scrollBy(-Math.max(0, Math.trunc(lines)));
    },
    rePin(): void {
      scroll.scrollToEnd();
    },
    appendDelta(delta: TranscriptDelta): void {
      // NOTE: callers must call updateLayout after arrivals — ScrollView
      // contentHeight is synced there, and scrollBy-from-tail uses it.
      const found = byId.get(delta.id);
      if (found === undefined) {
        const entry: TranscriptEntry = {
          id: delta.id,
          kind: delta.kind,
          markdown: delta.append,
        };
        entries.push(entry);
        byId.set(entry.id, entry);
      } else {
        // Entries are immutable: a streamed chunk replaces the object (the
        // delta path is rare next to a snapshot re-apply).
        const grown: TranscriptEntry = {
          ...found,
          markdown: found.markdown + delta.append,
        };
        const at = entries.indexOf(found);
        if (at !== -1) entries[at] = grown;
        byId.set(grown.id, grown);
      }
      if (logOps) {
        log.push({
          op: 'delta',
          delta: { id: delta.id, kind: delta.kind, append: delta.append },
        });
      }
      paint();
    },
    applyLaneSnapshot(
      lane: LaneIdentity,
      cells: ReadonlyArray<TranscriptEntry>,
      next: number,
    ): void {
      // Stale resnapshots are ignored so a re-watch replays gap-free.
      // Single-lane assumption: the guard tracks one (laneId, revision)
      // slot, so callers follow exactly one lane at a time.
      if (lane.laneId === laneId && next <= revision) return;
      laneId = lane.laneId;
      revision = next;
      const nextEntries = reuseUnchanged(cells, byId);
      entries.length = 0;
      entries.push(...nextEntries);
      byId.clear();
      for (const entry of nextEntries) byId.set(entry.id, entry);
      if (logOps) {
        log.push({
          op: 'snapshot',
          laneId: lane.laneId,
          cells: cells.map((cell) => ({ ...cell })),
          revision: next,
        });
      }
      paint();
    },
    render(width: number): string[] {
      return scroll.render(width);
    },
    markdownCacheSize(): number {
      return document.markdownCacheSize();
    },
    markdownParses(): number {
      return document.markdownParses();
    },
    liveCells(): ReadonlyArray<TranscriptEntry> {
      return entries.slice();
    },
    setWelcome(
      lines: ReadonlyArray<string> | ((width: number) => string[]),
    ): void {
      document.welcome = typeof lines === 'function' ? lines : [...lines];
    },
    setPendingPrompt(
      prompt: string | undefined,
      images?: readonly LaneImagePart[],
    ): void {
      document.pending = prompt;
      document.pendingImages = images ?? [];
    },
    setStream(text: string | undefined): void {
      // The streamed draft is untrusted lane text like
      // every other ingress — a delta carrying ESC/C0 must not reach a frame.
      document.stream = text === undefined ? undefined : sanitizeLaneText(text);
    },
    setQueuedPrompts(prompts: readonly string[]): void {
      // A queued draft is untrusted terminal input like
      // every other operator-facing string — a paste can carry ESC/C0 and a
      // tab breaks the width math. Sanitized at ingress, exactly like the
      // pending echo and the journal rows.
      document.queued = prompts.map((prompt) => sanitizeLaneText(prompt));
    },
    toggleExpanded(): boolean {
      document.expanded = !document.expanded;
      return document.expanded;
    },
    get expanded(): boolean {
      return document.expanded;
    },
    blocks: (): readonly TranscriptBlock[] => document.blocks,
    select: (id: string | undefined): void => {
      document.selected = id;
    },
    toggleBlock: (id: string): boolean => {
      if (document.expandedCells.delete(id)) return false;
      document.expandedCells.add(id);
      return true;
    },
    blockLines: (id: string, width: number): string[] =>
      document.renderCellAlone(id, width),
    reveal: (id: string): void => {
      const block = document.blocks.find((candidate) => candidate.id === id);
      if (block === undefined) return;
      const top = scroll.scrollTop;
      const height = Math.max(1, scroll.viewportHeight);
      if (block.firstRow < top) {
        scroll.scrollTo(block.firstRow);
      } else if (block.firstRow + block.rowCount > top + height) {
        scroll.scrollTo(
          Math.min(block.firstRow, block.firstRow + block.rowCount - height),
        );
      }
    },
  };
}
