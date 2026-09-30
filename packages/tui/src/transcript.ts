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
import { type TuiTheme, tuiTheme } from './theme.js';
import type { Component } from './tui-boundary.js';
import {
  Markdown,
  type MarkdownTheme,
  ScrollView,
  truncateToWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';

// 'prompt' is the operator's own line; 'text' is assistant prose (rendered
// as markdown); 'tool' is a call; 'output' is a call's result.
export type TranscriptEntryKind = 'prompt' | 'text' | 'tool' | 'output';

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
}

export interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

export type { LaneSnapshot };

// Collapsed tool output shows this many lines; Ctrl-X expands every block.
export const TOOL_OUTPUT_PREVIEW_LINES = 5;

const PROMPT_MARK = '›';
const ASSISTANT_MARK = '▪';
const TOOL_MARK = '●';
const OUTPUT_ELBOW = '⎿';

export function markdownThemeFor(theme: TuiTheme): MarkdownTheme {
  return {
    heading: theme.accentBold,
    link: theme.underline,
    linkUrl: theme.muted,
    code: theme.code,
    codeBlock: theme.code,
    codeBlockBorder: theme.muted,
    quote: theme.italic,
    quoteBorder: theme.accent,
    hr: theme.muted,
    listBullet: theme.accent,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: theme.strike,
    underline: theme.underline,
  };
}

function stripPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '…');
}

// The rendered document: welcome block, then one block per cell. Pure over
// its fields — the active theme is read per render, so a theme set after
// construction (the composition root) takes effect on the next frame.
class TranscriptDocument implements Component {
  cells: TranscriptEntry[] = [];
  welcome: string[] = [];
  pending: string | undefined;
  expanded = false;
  inline: ((width: number) => string[] | undefined) | undefined;
  private readonly markdownCache = new Map<string, Markdown>();

  invalidate(): void {
    this.markdownCache.clear();
  }

  private markdown(cell: TranscriptEntry, theme: TuiTheme): Markdown {
    const key = `${theme.level}\u0000${cell.id}`;
    let md = this.markdownCache.get(key);
    if (md === undefined) {
      md = new Markdown(cell.markdown, 0, 0, markdownThemeFor(theme));
      this.markdownCache.set(key, md);
    } else {
      md.setText(cell.markdown);
    }
    return md;
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const inline = this.inline?.(w);
    if (inline !== undefined) return inline;
    const theme = tuiTheme();
    const out: string[] = this.welcome.map((line) => fit(line, w));
    const outputs = new Map<string, TranscriptEntry>();
    for (const cell of this.cells) {
      if (cell.kind === 'output' && cell.toolCallId !== undefined) {
        outputs.set(cell.toolCallId, cell);
      }
    }
    const called = new Set<string>();
    for (const cell of this.cells) {
      if (cell.kind === 'tool' && cell.toolCallId !== undefined) {
        called.add(cell.toolCallId);
      }
    }
    const gap = (): void => {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    };
    for (const cell of this.cells) {
      switch (cell.kind) {
        case 'prompt': {
          gap();
          this.renderPrompt(out, cell.markdown, w, theme);
          break;
        }
        case 'tool': {
          gap();
          const result =
            cell.toolCallId === undefined
              ? undefined
              : outputs.get(cell.toolCallId);
          const glyph =
            result === undefined
              ? theme.warm(TOOL_MARK)
              : result.isError === true
                ? theme.error(TOOL_MARK)
                : theme.success(TOOL_MARK);
          const name = stripPrefix(cell.markdown, 'tool ');
          const detail =
            cell.detail === undefined ? '' : ` ${theme.muted(cell.detail)}`;
          out.push(fit(`${glyph} ${theme.bold(name)}${detail}`, w));
          if (result !== undefined) this.renderOutput(out, result, w, theme);
          break;
        }
        case 'output': {
          // Paired outputs render under their call; an orphan (no call in
          // view) renders on its own.
          if (cell.toolCallId !== undefined && called.has(cell.toolCallId)) {
            break;
          }
          this.renderOutput(out, cell, w, theme);
          break;
        }
        default: {
          if (cell.markdown.startsWith(`${PROMPT_MARK} `)) {
            gap();
            this.renderPrompt(out, cell.markdown, w, theme);
            break;
          }
          gap();
          const body = this.markdown(cell, theme).render(Math.max(1, w - 2));
          let first = true;
          for (const raw of body) {
            // Markdown pads rows to the width; the padding is dropped so a
            // row's length is its text (the alt-screen clears the rest).
            const line = raw.replace(/ +$/, '');
            if (first && line.trim() !== '') {
              out.push(fit(`${theme.accent(ASSISTANT_MARK)} ${line}`, w));
              first = false;
            } else {
              out.push(fit(`  ${line}`, w));
            }
          }
        }
      }
    }
    if (this.pending !== undefined) {
      gap();
      this.renderPrompt(out, `${PROMPT_MARK} ${this.pending}`, w, theme);
    }
    return out;
  }

  private renderPrompt(
    out: string[],
    markdown: string,
    width: number,
    theme: TuiTheme,
  ): void {
    const text = stripPrefix(markdown, `${PROMPT_MARK} `);
    const lines = wrapTextWithAnsi(text, Math.max(1, width - 2));
    lines.forEach((line, index) => {
      const mark = index === 0 ? theme.accentBold(PROMPT_MARK) : ' ';
      out.push(fit(`${mark} ${theme.prompt(line)}`, width));
    });
  }

  private renderOutput(
    out: string[],
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
  ): void {
    const lines = cell.markdown.split('\n');
    const shown = this.expanded
      ? lines
      : lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
    const style = cell.isError === true ? theme.error : theme.muted;
    shown.forEach((line, index) => {
      const lead = index === 0 ? `  ${theme.muted(OUTPUT_ELBOW)}  ` : '     ';
      out.push(fit(`${lead}${style(line)}`, width));
    });
    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      out.push(
        fit(
          `     ${theme.dim(`… +${hidden} lines (ctrl+x to expand)`)}`,
          width,
        ),
      );
    }
  }
}

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
  // TUI polish: the welcome block at the top of the document, the prompt
  // echoed before the lane commits it, and the expand-all toggle.
  setWelcome(lines: ReadonlyArray<string>): void;
  setPendingPrompt(prompt: string | undefined): void;
  toggleExpanded(): boolean;
  readonly expanded: boolean;
}

export interface TranscriptViewOptions {
  // Replaces the whole document while it returns lines (the approval's
  // inline fallback below the overlay's minimum width).
  readonly inline?: (width: number) => string[] | undefined;
}

export function createTranscriptView(
  options: TranscriptViewOptions = {},
): TranscriptView {
  const document = new TranscriptDocument();
  document.inline = options.inline;
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  });
  const entries: Array<{
    id: string;
    kind: TranscriptEntryKind;
    markdown: string;
    detail?: string;
    isError?: boolean;
    toolCallId?: string;
  }> = [];
  let rebuilds = 0;
  let laneId: string | undefined;
  let revision = -1;
  const log: Array<TranscriptOp> = [];
  const paint = (): void => {
    document.cells = entries.map((entry) => ({ ...entry }));
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
      // Single-lane assumption: the guard tracks one (laneId, revision)
      // slot, so callers follow exactly one lane at a time.
      if (lane.laneId === laneId && next <= revision) return;
      laneId = lane.laneId;
      revision = next;
      entries.length = 0;
      for (const cell of cells) {
        entries.push({ ...cell });
      }
      log.push({
        op: 'snapshot',
        laneId: lane.laneId,
        cells: cells.map((cell) => ({ ...cell })),
        revision: next,
      });
      paint();
    },
    render(width: number): string[] {
      return scroll.render(width);
    },
    setWelcome(lines: ReadonlyArray<string>): void {
      document.welcome = [...lines];
    },
    setPendingPrompt(prompt: string | undefined): void {
      document.pending = prompt;
    },
    toggleExpanded(): boolean {
      document.expanded = !document.expanded;
      return document.expanded;
    },
    get expanded(): boolean {
      return document.expanded;
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
