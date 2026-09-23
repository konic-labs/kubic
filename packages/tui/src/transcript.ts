// Follow-end transcript fed by LaneSnapshot coarse cells (issue #23).
// §16.1 follow-end pinned + manual scroll preserved; §18 text+tool/output
// interleaved inspectable; §61 immediate deltas, one markdown rebuild per
// entry; §80 streaming via replicated LaneSnapshot. Images and diff
// rendering are out of scope.
//
// The ScrollView owns follow state (follow:'end', primary nearest,
// overscroll chain); this module owns the document: delta appends rebuild
// the single Markdown child exactly once per entry and never clear it.
import type { LaneSnapshot } from '../../core/src/presentation.js';
import type { Component } from './tui-boundary.js';
import { Markdown, ScrollView } from './tui-boundary.js';

export type TranscriptEntryKind = 'text' | 'tool' | 'output';

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly markdown: string;
}

export interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

export type { LaneSnapshot };

const identity = (text: string): string => text;

const TRANSCRIPT_THEME = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

export interface TranscriptSnapshotOp {
  readonly op: 'snapshot';
  readonly laneId: string;
  readonly cells: ReadonlyArray<TranscriptEntry>;
  readonly revision: number;
}

export interface TranscriptDeltaOp {
  readonly op: 'delta';
  readonly delta: TranscriptDelta;
}

export type TranscriptOp = TranscriptSnapshotOp | TranscriptDeltaOp;

export interface TranscriptView {
  readonly component: Component;
  readonly scroll: ScrollView;
  readonly rebuilds: number;
  readonly isPinned: boolean;
  readonly scrollTop: number;
  readonly writeLog: ReadonlyArray<TranscriptOp>;
  appendDelta(delta: TranscriptDelta): void;
  applyLaneSnapshot(
    lane: LaneSnapshot,
    cells: ReadonlyArray<TranscriptEntry>,
    revision: number,
  ): void;
  updateLayout(contentHeight: number, viewportHeight: number): void;
  scrollUp(lines: number): void;
  rePin(): void;
  render(width: number): string[];
}

export function createTranscriptView(): TranscriptView {
  const document = new Markdown('', 0, 0, TRANSCRIPT_THEME);
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  });
  const entries: Array<{
    id: string;
    kind: TranscriptEntryKind;
    markdown: string;
  }> = [];
  let rebuilds = 0;
  let laneId: string | undefined;
  let revision = -1;
  const log: Array<TranscriptOp> = [];
  const paint = (): void => {
    document.setText(entries.map((entry) => entry.markdown).join('\n'));
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
      const found = entries.find((entry) => entry.id === delta.id);
      if (found === undefined) {
        entries.push({
          id: delta.id,
          kind: delta.kind,
          markdown: delta.append,
        });
      } else {
        found.markdown += delta.append;
      }
      log.push({
        op: 'delta',
        delta: { id: delta.id, kind: delta.kind, append: delta.append },
      });
      paint();
    },
    applyLaneSnapshot(
      lane: LaneSnapshot,
      cells: ReadonlyArray<TranscriptEntry>,
      next: number,
    ): void {
      // Stale resnapshots are ignored so a re-watch replays gap-free (§9.1).
      if (lane.laneId === laneId && next <= revision) return;
      laneId = lane.laneId;
      revision = next;
      entries.length = 0;
      for (const cell of cells) {
        entries.push({ id: cell.id, kind: cell.kind, markdown: cell.markdown });
      }
      log.push({
        op: 'snapshot',
        laneId: lane.laneId,
        cells: cells.map((cell) => ({
          id: cell.id,
          kind: cell.kind,
          markdown: cell.markdown,
        })),
        revision: next,
      });
      paint();
    },
    render(width: number): string[] {
      return scroll.render(width);
    },
  };
}

export function replayTranscript(
  ops: ReadonlyArray<TranscriptOp>,
): TranscriptView {
  const view = createTranscriptView();
  for (const op of ops) {
    if (op.op === 'delta') {
      view.appendDelta(op.delta);
    } else {
      view.applyLaneSnapshot({ laneId: op.laneId }, op.cells, op.revision);
    }
  }
  return view;
}
