// Follow-end transcript fed by LaneSnapshot coarse cells (issue #23).
// §16.1 follow-end pinned + manual scroll preserved; §18 text+tool/output
// interleaved inspectable; §61 immediate deltas, one markdown rebuild per
// entry; §80 streaming via replicated LaneSnapshot. Images and diff
// rendering are out of scope.
//
// The ScrollView owns follow state (follow:'end', primary nearest,
// overscroll chain); this module owns the document: delta appends rebuild
// the single Markdown child exactly once per entry and never clear it.
import type { LaneImagePart } from '../../core/src/presentation.js';
import { FOCUS_EDGE, PROSE } from '../../core/src/ui/glyphs.js';
import { createAttachmentComponent } from './attachments.js';
import { sanitizeLaneText } from './lane-cells.js';
import { type TuiTheme, tuiTheme } from './theme.js';
import { renderToolCard } from './tool-card.js';
import type { Component } from './tui-boundary.js';
import {
  Markdown,
  type MarkdownTheme,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';
import { leftRight } from './ui/line.js';
import { fillLine } from './ui/surface.js';

// 'prompt' is the operator's own line; 'text' is assistant prose (rendered
// as markdown); 'tool' is a call; 'output' is a call's result.
export type TranscriptEntryKind =
  | 'prompt'
  | 'text'
  | 'tool'
  | 'output'
  // Issue #317: a compaction summary the lane placed in the branch.
  | 'compaction';

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
  // Issue #338: images attached to this prompt (§16.8). Rendered under the
  // prompt text as the real image or the terminal placeholder.
  readonly images?: readonly LaneImagePart[];
  // Issue #455: when the entry was committed (ms since the epoch) — the
  // prompt block's `you · HH:MM:SS`.
  readonly timestamp?: number;
}

export interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

// The transcript only needs the lane's identity: the §66 state shape
// (presentation.ts) is the projector's business, and requiring all of it here
// would make every cell-application carry fields it never reads.
export interface LaneIdentity {
  readonly laneId: string;
}

// Collapsed tool output shows this many lines; Ctrl-X expands every block.
export const TOOL_OUTPUT_PREVIEW_LINES = 5;

const PROMPT_MARK = '›';

// Issue #455: what the composition root knows about a call that the
// committed entries do not say — how long it took (or has been running) and
// whether an approval holds it.
export interface ToolCallState {
  readonly durationMs?: number;
  readonly runningMs?: number;
  readonly waiting?: boolean;
}

/** Local `HH:MM:SS` for the prompt block. */
export function formatPromptTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// Issue #334: the label in front of a queued follow-up's first line. Plain
// ASCII, because it prefixes untrusted prompt text and must never be
// confused with a committed prompt row (`›`).
export const QUEUED_LABEL = 'queued:';

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

// One queued row's text: the label plus the prompt's first line. A multi-line
// draft is summarised, not dumped — the committed entry shows it in full.
export function queuedLine(prompt: string): string {
  const first = prompt.split('\n', 1)[0] ?? '';
  return `${QUEUED_LABEL} ${first}`;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '…');
}

// Cache keys are `${theme.level}\u0000${cell.id}`: the id is everything after
// the first NUL (entry ids never contain one).
function cellIdOf(key: string): string {
  const at = key.indexOf('\u0000');
  return at === -1 ? key : key.slice(at + 1);
}

// The image cache keys are `cellId\u0000index` (#338): the id is everything
// before the last separator, so the cell's components can be pruned with the
// markdown caches when a snapshot drops the cell.
function imageCellIdOf(key: string): string {
  const at = key.lastIndexOf('\u0000');
  return at === -1 ? key : key.slice(0, at);
}

// The rendered document: welcome block, then one block per cell. Pure over
// its fields — the active theme is read per render, so a theme set after
// construction (the composition root) takes effect on the next frame.
class TranscriptDocument implements Component {
  cells: TranscriptEntry[] = [];
  welcome: string[] = [];
  pending: string | undefined;
  // Issue #338: the images the echoed prompt carries.
  pendingImages: readonly LaneImagePart[] = [];
  // Issue #334: follow-ups the conversation's inbox holds but no turn has
  // placed yet. Rendered dim under the transcript (and under the pending
  // echo), so the operator sees the prompt was accepted — never dropped.
  queued: string[] = [];
  // Issue #296: the in-flight generation's text (the lane's message deltas).
  // Rendered as a plain draft after the committed cells; the committed
  // assistant entry replaces it, so it is never part of the cell list.
  stream: string | undefined;
  expanded = false;
  inline: ((width: number) => string[] | undefined) | undefined;
  // Issue #455: per-call facts from the composition root, and the expand
  // key's cap for the card footers.
  toolState: ((toolCallId: string) => ToolCallState | undefined) | undefined;
  expandKey: (() => string) | undefined;
  private readonly markdownCache = new Map<string, Markdown>();
  // Issue #298: the text each cached Markdown was built from, and the final
  // rendered lines of each cell. pi-tui's `setText` invalidates
  // unconditionally, so calling it every frame re-parsed every assistant
  // cell; the document therefore only pushes a cell's lines when its text,
  // width or theme actually changed.
  private readonly markdownText = new Map<string, string>();
  private readonly lineCache = new Map<
    string,
    { text: string; width: number; lines: string[] }
  >();
  // A parse is forced by constructing a Markdown or by setText; tests pin
  // that a steady frame adds none.
  private parses = 0;
  // Issue #338: one component per attached image, keyed by cell and index —
  // the kitty protocol path allocates an image id that must be reused
  // across frames instead of re-uploaded.
  private readonly imageCache = new Map<string, Component>();

  invalidate(): void {
    this.markdownCache.clear();
    this.markdownText.clear();
    this.lineCache.clear();
    this.imageCache.clear();
  }

  // Issue #298: the cells a snapshot carries REPLACE the previous set, so a
  // cache entry whose id left the snapshot is dead weight (a long session
  // would otherwise hold every markdown cell it ever showed). The image
  // components are keyed by cell too (#338), so they are pruned the same way.
  setCells(cells: TranscriptEntry[]): void {
    this.cells = cells;
    const live = new Set(cells.map((cell) => cell.id));
    for (const key of this.markdownCache.keys()) {
      if (!live.has(cellIdOf(key))) {
        this.markdownCache.delete(key);
        this.markdownText.delete(key);
      }
    }
    for (const key of this.lineCache.keys()) {
      if (!live.has(cellIdOf(key))) this.lineCache.delete(key);
    }
    for (const key of this.imageCache.keys()) {
      if (!live.has(imageCellIdOf(key))) this.imageCache.delete(key);
    }
  }

  markdownCacheSize(): number {
    return this.markdownCache.size;
  }

  markdownParses(): number {
    return this.parses;
  }

  private markdown(cell: TranscriptEntry, theme: TuiTheme): Markdown {
    const key = `${theme.level}\u0000${cell.id}`;
    let md = this.markdownCache.get(key);
    if (md === undefined) {
      md = new Markdown(cell.markdown, 0, 0, markdownThemeFor(theme));
      this.markdownCache.set(key, md);
      this.parses += 1;
    } else if (this.markdownText.get(key) !== cell.markdown) {
      md.setText(cell.markdown);
      this.parses += 1;
    }
    this.markdownText.set(key, cell.markdown);
    return md;
  }

  // The cell's finished rows (indent, prefix, width clamp, styling), reused
  // while text, width and theme are unchanged. `undefined` means "render it
  // and store the result".
  private cachedLines(
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
  ): string[] | undefined {
    const cached = this.lineCache.get(`${theme.level}\u0000${cell.id}`);
    if (cached === undefined) return undefined;
    if (cached.text !== cell.markdown || cached.width !== width) {
      return undefined;
    }
    return cached.lines;
  }

  private storeLines(
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
    lines: string[],
  ): void {
    this.lineCache.set(`${theme.level}\u0000${cell.id}`, {
      text: cell.markdown,
      width,
      lines,
    });
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const inline = this.inline?.(w);
    if (inline !== undefined) return inline;
    const theme = tuiTheme();
    // Issue #453: welcome lines wrap rather than cut — the honest lane
    // notice they carry is read whole.
    const out: string[] = this.welcome.flatMap((line) =>
      line === ''
        ? ['']
        : wrapTextWithAnsi(line, w).map((part) => fit(part, w)),
    );
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
          this.renderPrompt(
            out,
            cell.markdown,
            w,
            theme,
            cell.images,
            cell.id,
            cell.timestamp,
          );
          break;
        }
        case 'tool': {
          gap();
          const result =
            cell.toolCallId === undefined
              ? undefined
              : outputs.get(cell.toolCallId);
          out.push(...this.card(cell, result, w, theme));
          break;
        }
        case 'compaction': {
          // Issue #317/#455: a rule names what happened; the summary
          // follows, collapsed like a card body (Ctrl-X expands it).
          gap();
          const label = ` compacted${cell.detail === undefined ? '' : ` · ${cell.detail}`} `;
          const side = Math.max(2, Math.floor((w - visibleWidth(label)) / 2));
          const rest = Math.max(0, w - side - visibleWidth(label));
          out.push(
            fit(
              theme.ui.fg('fg2')(
                `${'─'.repeat(side)}${label}${'─'.repeat(rest)}`,
              ),
              w,
            ),
          );
          this.renderBlock(out, cell.markdown.split('\n'), w, theme);
          break;
        }
        case 'output': {
          // Paired outputs render under their call; an orphan (no call in
          // view) renders on its own.
          if (cell.toolCallId !== undefined && called.has(cell.toolCallId)) {
            break;
          }
          gap();
          out.push(...this.card(undefined, cell, w, theme));
          break;
        }
        default: {
          if (cell.markdown.startsWith(`${PROMPT_MARK} `)) {
            gap();
            this.renderPrompt(
              out,
              cell.markdown,
              w,
              theme,
              cell.images,
              cell.id,
              cell.timestamp,
            );
            break;
          }
          gap();
          const cached = this.cachedLines(cell, w, theme);
          if (cached !== undefined) {
            out.push(...cached);
            break;
          }
          const body = this.markdown(cell, theme).render(Math.max(1, w - 4));
          const lines: string[] = [];
          let first = true;
          for (const raw of body) {
            // Markdown pads rows to the width; the padding is dropped so a
            // row's length is its text (the alt-screen clears the rest).
            const line = raw.replace(/ +$/, '');
            if (first && line.trim() !== '') {
              lines.push(fit(`  ${theme.ui.fg('fg1')(PROSE)} ${line}`, w));
              first = false;
            } else {
              lines.push(fit(line === '' ? '' : `    ${line}`, w));
            }
          }
          this.storeLines(cell, w, theme, lines);
          out.push(...lines);
          break;
        }
      }
    }
    if (this.stream !== undefined && this.stream !== '') {
      // Issue #296 (§61): the in-flight generation's text, rendered as it
      // arrives. Plain text, not markdown — the committed entry is the one
      // markdown rebuild per entry — and dim, because it is not committed.
      gap();
      const lines = wrapTextWithAnsi(this.stream, Math.max(1, w - 4));
      lines.forEach((line, index) => {
        out.push(
          fit(
            index === 0
              ? `  ${theme.ui.fg('fg1')(PROSE)} ${theme.dim(line)}`
              : `    ${theme.dim(line)}`,
            w,
          ),
        );
      });
    }
    if (this.pending !== undefined) {
      gap();
      this.renderPrompt(
        out,
        `${PROMPT_MARK} ${this.pending}`,
        w,
        theme,
        this.pendingImages,
        'pending',
      );
    }
    for (const prompt of this.queued) {
      gap();
      out.push(fit(`  ${theme.dim(queuedLine(prompt))}`, w));
    }
    return out;
  }

  // Issue #455 (01-B): the operator's own turn — a full-width bg2 block
  // with the accent edge, the text fg0 bold, and `you · HH:MM:SS` on the
  // right when the entry carries its time.
  private renderPrompt(
    out: string[],
    markdown: string,
    width: number,
    theme: TuiTheme,
    images?: readonly LaneImagePart[],
    cellId?: string,
    timestamp?: number,
  ): void {
    const ui = theme.ui;
    const text = stripPrefix(markdown, `${PROMPT_MARK} `);
    const stamp =
      timestamp === undefined ? '' : `you · ${formatPromptTime(timestamp)}`;
    const edge = ui.fg('accent')(` ${FOCUS_EDGE} `);
    const body = ui.style({ fg: 'fg0', bold: true });
    const room = Math.max(
      1,
      width - 3 - (stamp === '' ? 1 : visibleWidth(stamp) + 2),
    );
    const lines = text === '' ? [''] : wrapTextWithAnsi(text, room);
    lines.forEach((line, index) => {
      const left = `${edge}${body(line)}`;
      const row =
        index === 0 && stamp !== ''
          ? leftRight(left, `${ui.fg('fg2')(stamp)} `, width)
          : left;
      out.push(fillLine(ui, row, width, 'bg2'));
    });
    this.renderImages(out, images, width, theme, cellId ?? '');
  }

  // Issue #455 (01-D/E): a call and its result as one card.
  private card(
    call: TranscriptEntry | undefined,
    result: TranscriptEntry | undefined,
    width: number,
    theme: TuiTheme,
  ): string[] {
    const toolCallId = call?.toolCallId ?? result?.toolCallId;
    const state =
      toolCallId === undefined ? undefined : this.toolState?.(toolCallId);
    return renderToolCard(
      theme.ui,
      {
        name:
          call === undefined ? 'result' : stripPrefix(call.markdown, 'tool '),
        ...(call?.detail === undefined ? {} : { target: call.detail }),
        ...(result === undefined ? {} : { output: result.markdown }),
        ...(result?.isError === true ? { isError: true } : {}),
        ...(state?.durationMs === undefined
          ? {}
          : { durationMs: state.durationMs }),
        ...(state?.runningMs === undefined
          ? {}
          : { runningMs: state.runningMs }),
        ...(state?.waiting === true ? { waiting: true } : {}),
        expanded: this.expanded,
        expandKey: this.expandKey?.() ?? '^X',
      },
      width,
    );
  }

  // Issue #338: one attached image under the prompt text. Protocol lines are
  // pushed unchanged (truncating a kitty/iTerm2 sequence would corrupt it);
  // the placeholder component already fits itself to the width.
  private renderImages(
    out: string[],
    images: readonly LaneImagePart[] | undefined,
    width: number,
    theme: TuiTheme,
    key: string,
  ): void {
    if (images === undefined || images.length === 0) return;
    const inner = Math.max(1, width - 2);
    images.forEach((image, index) => {
      const cacheKey = `${key}\u0000${index}`;
      let component = this.imageCache.get(cacheKey);
      if (component === undefined) {
        component = createAttachmentComponent(image, theme);
        this.imageCache.set(cacheKey, component);
      }
      for (const line of component.render(inner)) out.push(`  ${line}`);
    });
  }

  // A compaction summary (#317): collapsed shows the first rows behind a
  // gutter and says what it hides; expanded wraps everything.
  private renderBlock(
    out: string[],
    lines: string[],
    width: number,
    theme: TuiTheme,
  ): void {
    const ui = theme.ui;
    const gutter = `  ${ui.fg('fg3')('│')} `;
    const bodyWidth = Math.max(1, width - visibleWidth(gutter));
    const shown = this.expanded
      ? lines
      : lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
    let clipped = false;
    for (const line of shown) {
      if (this.expanded) {
        for (const row of wrapTextWithAnsi(line, bodyWidth)) {
          out.push(fit(`${gutter}${ui.fg('fg2')(row)}`, width));
        }
        continue;
      }
      if (visibleWidth(line) > bodyWidth) clipped = true;
      out.push(fit(`${gutter}${ui.fg('fg2')(line)}`, width));
    }
    const hidden = lines.length - shown.length;
    if (hidden > 0 || clipped) {
      const parts: string[] = [];
      if (hidden > 0) parts.push(`+${hidden} line${hidden === 1 ? '' : 's'}`);
      if (clipped) parts.push('wide lines cut');
      const key = this.expandKey?.() ?? '^X';
      out.push(
        fit(
          `  ${ui.fg('fg3')('└')} ${ui.fg('fg2')(parts.join(' · '))}${key === '' ? '' : `   ${ui.fg('fg1')(key)}${ui.fg('fg2')(' expand')}`}`,
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
    lane: LaneIdentity,
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
  setPendingPrompt(
    prompt: string | undefined,
    images?: readonly LaneImagePart[],
  ): void;
  // Issue #296: the streamed draft of the in-flight generation (undefined
  // clears it). The committed entry replaces it.
  setStream(text: string | undefined): void;
  // Issue #334: the queued follow-ups (`pi.inbox`), newest last. A fresh
  // call REPLACES the rows — the inbox event is a snapshot, not a delta.
  setQueuedPrompts(prompts: readonly string[]): void;
  toggleExpanded(): boolean;
  readonly expanded: boolean;
  // Issue #298: cache counters the perf tests assert on — the live markdown
  // entries and how many parses (constructor + setText) the document forced.
  markdownCacheSize(): number;
  markdownParses(): number;
  // Issue #297: the live cell objects (a copy of the ARRAY; the objects are
  // the live ones). Tests pin that an identical snapshot preserves identity.
  liveCells(): ReadonlyArray<TranscriptEntry>;
}

export interface TranscriptViewOptions {
  // Replaces the whole document while it returns lines (the approval's
  // inline fallback below the overlay's minimum width).
  readonly inline?: (width: number) => string[] | undefined;
  // Issue #297: the op log is OPT-IN. It exists for `replayTranscript` and
  // the tests that drive it; production applies a snapshot on every lane
  // event, so an always-on log retained a deep copy of every one (O(N·E)
  // cells, tool outputs up to 20k chars). Absent means no log at all.
  readonly ops?: boolean;
  // Issue #455: per-call facts (duration, running clock, waiting on an
  // approval) and the expand key's cap for the card footers.
  readonly toolState?: (toolCallId: string) => ToolCallState | undefined;
  readonly expandKey?: () => string;
}

// Issue #297: two cells are the same entry when every field the transcript
// renders matches — then a re-applied snapshot can keep the live object.
function sameCell(left: TranscriptEntry, right: TranscriptEntry): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.markdown === right.markdown &&
    left.detail === right.detail &&
    left.isError === right.isError &&
    left.toolCallId === right.toolCallId &&
    left.timestamp === right.timestamp
  );
}

export function createTranscriptView(
  options: TranscriptViewOptions = {},
): TranscriptView {
  const document = new TranscriptDocument();
  document.inline = options.inline;
  document.toolState = options.toolState;
  document.expandKey = options.expandKey;
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  });
  const entries: TranscriptEntry[] = [];
  // The live object per id: a re-applied snapshot reuses it (#297), and the
  // delta path mutates it in place.
  const byId = new Map<string, TranscriptEntry>();
  const logOps = options.ops === true;
  let rebuilds = 0;
  let laneId: string | undefined;
  let revision = -1;
  const log: TranscriptOp[] = [];
  const paint = (): void => {
    // Issue #298: through setCells, so a cell that left the snapshot also
    // leaves the markdown/line caches. Issue #297: only the ARRAY is copied
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
      // Stale resnapshots are ignored so a re-watch replays gap-free (§9.1).
      // Single-lane assumption: the guard tracks one (laneId, revision)
      // slot, so callers follow exactly one lane at a time.
      if (lane.laneId === laneId && next <= revision) return;
      laneId = lane.laneId;
      revision = next;
      // Issue #297: diff by id and keep the object of every unchanged cell.
      // The TUI applies a snapshot per lane event, so copying every cell each
      // time allocated the whole document per event (and invalidated the
      // render caches keyed on the object's text).
      const nextEntries: TranscriptEntry[] = [];
      const nextById = new Map<string, TranscriptEntry>();
      for (const cell of cells) {
        const previous = byId.get(cell.id);
        const entry =
          previous !== undefined && sameCell(previous, cell)
            ? previous
            : { ...cell };
        nextEntries.push(entry);
        nextById.set(cell.id, entry);
      }
      entries.length = 0;
      entries.push(...nextEntries);
      byId.clear();
      for (const [id, entry] of nextById) byId.set(id, entry);
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
    setWelcome(lines: ReadonlyArray<string>): void {
      document.welcome = [...lines];
    },
    setPendingPrompt(
      prompt: string | undefined,
      images?: readonly LaneImagePart[],
    ): void {
      document.pending = prompt;
      document.pendingImages = images ?? [];
    },
    setStream(text: string | undefined): void {
      // Issue #296 (review): the streamed draft is untrusted lane text like
      // every other ingress — a delta carrying ESC/C0 must not reach a frame.
      document.stream = text === undefined ? undefined : sanitizeLaneText(text);
    },
    setQueuedPrompts(prompts: readonly string[]): void {
      // Issue #334 (review): a queued draft is untrusted terminal input like
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
