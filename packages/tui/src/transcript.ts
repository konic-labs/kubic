// Follow-end transcript fed by LaneSnapshot coarse cells.
// Follow-end pinned + manual scroll preserved; text+tool/output
// interleaved inspectable; immediate deltas, one markdown rebuild per
// entry; streaming via replicated LaneSnapshot. Images and diff
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
import { formatToolDuration, renderToolCard } from './tool-card.js';
import type { Component } from './tui-boundary.js';
import {
  getCapabilities,
  Markdown,
  type MarkdownTheme,
  ScrollView,
  truncateToWidth,
  visibleWidth,
} from './tui-boundary.js';
import { linkFileReferences } from './ui/file-links.js';
import { highlightCode } from './ui/highlight.js';
import { closeOpenStyles, leftRight, wrapStyled } from './ui/line.js';
import { fillLine } from './ui/surface.js';

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
type TranscriptBlockKind =
  | 'prompt'
  | 'prose'
  | 'thinking'
  | 'tool'
  | 'compaction'
  | 'receipt';

interface TranscriptBlock {
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR is the point
const SGR = /\u001b\[[0-9;]*m/gu;

function plainText(line: string): string {
  return line.replace(SGR, '');
}

// The selected block's edge: its first visible cell becomes the mark; the
// line's leading colour (a surface) is kept.
function withEdge(line: string, mark: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR is the point
  const hit = /^((?:\u001b\[[0-9;]*m)*)[\s\S]/u.exec(line);
  if (hit === null) return mark;
  return `${hit[1] ?? ''}${mark}${line.slice(hit[0].length)}`;
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
// file's size and first lines) — a structural mirror of the worker's
// ToolDisplay (dep-lint forbids tui → worker), sanitized at ingress.
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

function displayKey(display: CellDisplay | undefined): string {
  if (display === undefined) return '';
  return display.kind === 'diff'
    ? `d\u0000${display.added}\u0000${display.removed}\u0000${display.text}`
    : `w\u0000${display.newFile}\u0000${display.lines}\u0000${display.preview}`;
}

interface TranscriptDelta {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly append: string;
}

// The transcript only needs the lane's identity: the presentation state shape
// (presentation.ts) is the projector's business, and requiring all of it here
// would make every cell-application carry fields it never reads.
interface LaneIdentity {
  readonly laneId: string;
}

// Collapsed tool output shows this many lines; Ctrl-X expands every block.
export const TOOL_OUTPUT_PREVIEW_LINES = 5;

const PROMPT_MARK = '›';
const THINKING_MARK = '⋯';

/** `4.1s`, `1:05`. */
function formatThinkingTime(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return formatToolDuration(value);
}

/** The reasoning's first sentence, on one line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?:\s|$)/u.exec(flat);
  return end === null ? flat : flat.slice(0, end.index + 1);
}

/**
 * `✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031` with
 * `^O review diff   /undo revert` on the right when files changed; the
 * right part drops first on a narrow terminal.
 */
export function renderReceipt(
  ui: TuiTheme['ui'],
  receipt: TurnReceipt,
  width: number,
): string {
  const time = formatThinkingTime(receipt.elapsedMs);
  if (receipt.outcome !== 'completed') {
    const failed = receipt.outcome === 'failed';
    const head = failed
      ? `${ui.fg('err')('✕')} ${ui.fg('fg1')(`turn failed · ${time}`)}`
      : `${ui.fg('fg2')('○')} ${ui.fg('fg1')(`turn cancelled · ${time}`)}`;
    const detail =
      receipt.detail === undefined || receipt.detail === ''
        ? ''
        : ui.fg('fg2')(` · ${receipt.detail}`);
    return fit(`  ${head}${detail}`, width);
  }
  const parts = [`turn ${time}`];
  if (receipt.tools > 0) {
    parts.push(`${receipt.tools} tool${receipt.tools === 1 ? '' : 's'}`);
  }
  let files = '';
  if (receipt.files > 0) {
    files = ` · ${receipt.files} file${receipt.files === 1 ? '' : 's'}`;
  }
  const counts =
    receipt.files > 0 &&
    receipt.added !== undefined &&
    receipt.removed !== undefined
      ? ` ${ui.fg('add')(`+${receipt.added}`)} ${ui.fg('del')(`−${receipt.removed}`)}`
      : '';
  const cost = ui.fg('fg1')(
    ` · $${receipt.costUsd < 1 ? receipt.costUsd.toFixed(3) : receipt.costUsd.toFixed(2)}`,
  );
  const left = `  ${ui.fg('ok')('✓')} ${ui.fg('fg1')(`${parts.join(' · ')}${files}`)}${counts}${cost}`;
  const diffKey = receipt.diffKey ?? '';
  const right =
    receipt.files === 0
      ? ''
      : `${diffKey === '' ? '' : `${ui.fg('fg1')(diffKey)}${ui.fg('fg2')(' review diff')}   `}${ui.fg('fg1')('/undo')}${ui.fg('fg2')(' revert')} `;
  return right !== '' && visibleWidth(left) + 2 + visibleWidth(right) <= width
    ? leftRight(left, right, width)
    : fit(left, width);
}

// What the composition root knows about a call that the
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
// The label in front of a queued follow-up's first line. Plain
// ASCII, because it prefixes untrusted prompt text and must never be
// confused with a committed prompt row (`›`).
export const QUEUED_LABEL = 'queued:';

// Markdown on the design tokens — calm headings, inline
// code on bg2, fenced code in a fg3 `┌ lang` / `└` frame with highlighted
// lines behind a `│` gutter, info links, fg2 `•` bullets, fg3 quote gutters.
export function markdownThemeFor(theme: TuiTheme): MarkdownTheme {
  const ui = theme.ui;
  // Pi draws a fence's opening and closing border through one hook; the two
  // calls alternate, and a fence with no language passes the same text both
  // times, so the side is tracked here.
  let inFence = false;
  return {
    heading: ui.style({ fg: 'fg0', bold: true }),
    link: ui.fg('info'),
    linkUrl: ui.fg('fg2'),
    code: (text: string): string =>
      ui.style({ fg: 'fg0', bg: 'bg2' })(` ${text} `),
    codeBlock: ui.fg('fg1'),
    codeBlockBorder: (text: string): string => {
      const opening = !inFence;
      inFence = !inFence;
      const language = text.replace(/^`+/u, '').trim();
      return ui.fg('fg3')(
        opening ? (language === '' ? '┌' : `┌ ${language}`) : '└',
      );
    },
    codeBlockIndent: ui.fg('fg3')('│ '),
    highlightCode: (code: string, language?: string): string[] =>
      highlightCode(ui, code, language),
    quote: ui.fg('fg1'),
    quoteBorder: ui.fg('fg3'),
    hr: ui.fg('fg3'),
    listBullet: (marker: string): string =>
      ui.fg('fg2')(marker.replace(/^[-*+](?=\s|$)/u, '•')),
    bold: ui.style({ fg: 'fg0', bold: true }),
    italic: ui.style({ fg: 'fg1', italic: true }),
    strikethrough: ui.style({ fg: 'fg2', strike: true }),
    underline: ui.style({ underline: true }),
  };
}

function stripPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

// One queued row's text: the label plus the prompt's first line. A multi-line
// draft is summarised, not dumped — the committed entry shows it in full.
function queuedLine(prompt: string): string {
  const first = prompt.split('\n', 1)[0] ?? '';
  return `${QUEUED_LABEL} ${first}`;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '…');
}

// Cache keys are `${theme.level}\u0000${cell.id}`: the id is everything after
// the first NUL (entry ids never contain one).
// Cache entries are per theme AND depth — a live theme switch
// at the same depth must repaint, not reuse the old colours. Names hold no
// NUL, so the cell id is still everything after the first one.
function themeKey(theme: TuiTheme): string {
  return `${theme.ui.name} ${theme.level}`;
}

function cellIdOf(key: string): string {
  const at = key.indexOf('\u0000');
  return at === -1 ? key : key.slice(at + 1);
}

// The image cache keys are `cellId\u0000index`: the id is everything
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
  // Block mode — the blocks of the last render, the selected
  // one, and the blocks expanded one by one (`x`).
  blocks: TranscriptBlock[] = [];
  selected: string | undefined;
  readonly expandedCells = new Set<string>();
  // The welcome block — fixed lines, or the preflight drawn at
  // the frame's width.
  welcome: readonly string[] | ((width: number) => string[]) = [];
  pending: string | undefined;
  // The images the echoed prompt carries.
  pendingImages: readonly LaneImagePart[] = [];
  // Follow-ups the conversation's inbox holds but no turn has
  // placed yet. Rendered dim under the transcript (and under the pending
  // echo), so the operator sees the prompt was accepted — never dropped.
  queued: string[] = [];
  // The in-flight generation's text (the lane's message deltas).
  // Rendered as a plain draft after the committed cells; the committed
  // assistant entry replaces it, so it is never part of the cell list.
  stream: string | undefined;
  expanded = false;
  inline: ((width: number) => string[] | undefined) | undefined;
  // Per-call facts from the composition root, and the expand
  // key's cap for the card footers.
  toolState: ((toolCallId: string) => ToolCallState | undefined) | undefined;
  expandKey: (() => string) | undefined;
  // A project file's `file://` URL (undefined: not a file).
  fileUrl: ((path: string) => string | undefined) | undefined;
  private readonly markdownCache = new Map<string, Markdown>();
  // The text each cached Markdown was built from, and the final
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
  // One component per attached image, keyed by cell and index —
  // the kitty protocol path allocates an image id that must be reused
  // across frames instead of re-uploaded.
  private readonly imageCache = new Map<string, Component>();

  invalidate(): void {
    this.markdownCache.clear();
    this.markdownText.clear();
    this.lineCache.clear();
    this.imageCache.clear();
  }

  // The cells a snapshot carries REPLACE the previous set, so a
  // cache entry whose id left the snapshot is dead weight (a long session
  // would otherwise hold every markdown cell it ever showed). The image
  // components are keyed by cell too, so they are pruned the same way.
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
    const key = `${themeKey(theme)}\u0000${cell.id}`;
    let md = this.markdownCache.get(key);
    if (md === undefined) {
      // File references become OSC 8 links — only where the
      // terminal opens them (Pi's fallback would print every URL inline).
      const resolve = this.fileUrl;
      md = new Markdown(
        cell.markdown,
        0,
        0,
        markdownThemeFor(theme),
        undefined,
        resolve !== undefined && getCapabilities().hyperlinks
          ? { transform: (text: string) => linkFileReferences(text, resolve) }
          : undefined,
      );
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
  // `stamp` is everything else the rows were drawn from (a prompt's time).
  private cachedLines(
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
    stamp = cell.markdown,
  ): string[] | undefined {
    const cached = this.lineCache.get(`${themeKey(theme)}\u0000${cell.id}`);
    if (cached === undefined) return undefined;
    if (cached.text !== stamp || cached.width !== width) {
      return undefined;
    }
    return cached.lines;
  }

  private storeLines(
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
    lines: string[],
    stamp = cell.markdown,
  ): void {
    this.lineCache.set(`${themeKey(theme)}\u0000${cell.id}`, {
      text: stamp,
      width,
      lines,
    });
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const inline = this.inline?.(w);
    if (inline !== undefined) return inline;
    const theme = tuiTheme();
    // Welcome lines wrap rather than cut — the honest lane
    // notice they carry is read whole.
    const welcome =
      typeof this.welcome === 'function' ? this.welcome(w) : this.welcome;
    const out: string[] = welcome.flatMap((line) =>
      line === '' ? [''] : wrapStyled(line, w).map((part) => fit(part, w)),
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
    // The blocks block mode walks — each cell's rows, as drawn.
    const blocks: TranscriptBlock[] = [];
    for (const cell of this.cells) {
      const before = out.length;
      const info = this.renderCell(cell, out, w, theme, outputs, called, gap);
      // No style a cell opens (a wrapped code row's colour, say)
      // bleeds past the row it was drawn on. Cached rows were closed when
      // they were cached, so a steady frame never scans them again.
      if (info?.closed !== true) {
        for (let row = before; row < out.length; row += 1) {
          out[row] = closeOpenStyles(out[row] ?? '');
        }
      }
      if (info === undefined || out.length === before) continue;
      // The gap row (if one was pushed) belongs to no block.
      const firstRow = out[before] === '' ? before + 1 : before;
      blocks.push({
        id: cell.id,
        kind: info.kind,
        firstRow,
        rowCount: out.length - firstRow,
        copyText: info.copy,
        metaText: info.meta ?? info.copy,
      });
    }
    this.blocks = blocks;
    const selected = blocks.find((block) => block.id === this.selected);
    if (selected !== undefined) {
      const edge = theme.ui.style({ fg: 'accent', bold: true })('▌');
      for (let row = 0; row < selected.rowCount; row += 1) {
        const at = selected.firstRow + row;
        out[at] = withEdge(out[at] ?? '', edge);
      }
    }
    if (this.stream !== undefined && this.stream !== '') {
      // The in-flight generation's text, rendered as it
      // arrives. Plain text, not markdown — the committed entry is the one
      // markdown rebuild per entry — and dim, because it is not committed.
      gap();
      const lines = wrapStyled(this.stream, Math.max(1, w - 4));
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

  // One cell's rows (shared by the document and the block
  // viewer), and what block mode copies from it. Undefined: no block (an
  // output drawn under its call, an empty receipt).
  private renderCell(
    cell: TranscriptEntry,
    out: string[],
    w: number,
    theme: TuiTheme,
    outputs: ReadonlyMap<string, TranscriptEntry>,
    called: ReadonlySet<string>,
    gap: () => void,
    forceExpanded = false,
  ):
    | {
        readonly kind: TranscriptBlockKind;
        readonly copy: string;
        readonly meta?: string;
        /** Every row it pushed is already closed: built that way. */
        readonly closed?: boolean;
      }
    | undefined {
    const expanded =
      forceExpanded || this.expanded || this.expandedCells.has(cell.id);
    switch (cell.kind) {
      case 'prompt': {
        gap();
        return {
          kind: 'prompt',
          copy: stripPrefix(cell.markdown, `${PROMPT_MARK} `),
          closed: this.pushPrompt(out, cell, w, theme),
        };
      }
      case 'tool': {
        gap();
        const result =
          cell.toolCallId === undefined
            ? undefined
            : outputs.get(cell.toolCallId);
        out.push(...this.card(cell, result, w, theme, expanded));
        const name = stripPrefix(cell.markdown, 'tool ');
        return {
          kind: 'tool',
          copy: result?.markdown ?? '',
          meta: `${name}${cell.detail === undefined ? '' : ` ${cell.detail}`}`,
        };
      }
      case 'compaction': {
        // A rule names what happened; the summary
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
        this.renderBlock(out, cell.markdown.split('\n'), w, theme, expanded);
        return { kind: 'compaction', copy: cell.markdown };
      }
      case 'thinking': {
        gap();
        out.push(...this.thinking(cell, w, theme, expanded));
        return { kind: 'thinking', copy: cell.markdown };
      }
      case 'receipt': {
        if (cell.receipt === undefined) return undefined;
        gap();
        const line = renderReceipt(theme.ui, cell.receipt, w);
        out.push(line);
        return { kind: 'receipt', copy: plainText(line).trim() };
      }
      case 'output': {
        // Paired outputs render under their call; an orphan (no call in
        // view) renders on its own.
        if (cell.toolCallId !== undefined && called.has(cell.toolCallId)) {
          return undefined;
        }
        gap();
        out.push(...this.card(undefined, cell, w, theme, expanded));
        return { kind: 'tool', copy: cell.markdown };
      }
      default: {
        if (cell.markdown.startsWith(`${PROMPT_MARK} `)) {
          gap();
          return {
            kind: 'prompt',
            copy: stripPrefix(cell.markdown, `${PROMPT_MARK} `),
            closed: this.pushPrompt(out, cell, w, theme),
          };
        }
        gap();
        const cached = this.cachedLines(cell, w, theme);
        if (cached !== undefined) {
          out.push(...cached);
          return { kind: 'prose', copy: cell.markdown, closed: true };
        }
        const body = this.markdown(cell, theme).render(Math.max(1, w - 4));
        const lines: string[] = [];
        let first = true;
        for (const raw of body) {
          // Markdown pads rows to the width; the padding is dropped so a
          // row's length is its text (the alt-screen clears the rest).
          const line = raw.replace(/ +$/, '');
          if (first && line.trim() !== '') {
            lines.push(
              closeOpenStyles(fit(`  ${theme.ui.fg('fg1')(PROSE)} ${line}`, w)),
            );
            first = false;
          } else {
            lines.push(
              closeOpenStyles(fit(line === '' ? '' : `    ${line}`, w)),
            );
          }
        }
        this.storeLines(cell, w, theme, lines);
        out.push(...lines);
        return { kind: 'prose', copy: cell.markdown, closed: true };
      }
    }
  }

  // One block alone and whole (expanded), for the block viewer.
  renderCellAlone(id: string, width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const cell = this.cells.find((candidate) => candidate.id === id);
    if (cell === undefined) return [];
    const outputs = new Map<string, TranscriptEntry>();
    for (const candidate of this.cells) {
      if (candidate.kind === 'output' && candidate.toolCallId !== undefined) {
        outputs.set(candidate.toolCallId, candidate);
      }
    }
    const out: string[] = [];
    this.renderCell(
      cell,
      out,
      w,
      tuiTheme(),
      outputs,
      new Set<string>(),
      () => {},
      true,
    );
    return out.map(closeOpenStyles);
  }

  // The operator's own turn — a full-width bg2 block
  // with the accent edge, the text fg0 bold, and `you · HH:MM:SS` on the
  // right when the entry carries its time.
  // A committed prompt's block is cached like prose — drawn once
  // per text, stamp, width and theme, its rows closed when cached —
  // so a steady frame does not redraw every prompt of a long session. True
  // when every row it pushed came closed (no attachment rows).
  private pushPrompt(
    out: string[],
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
  ): boolean {
    const stamp = `${cell.markdown}\u0000${cell.timestamp ?? ''}`;
    let rows = this.cachedLines(cell, width, theme, stamp);
    if (rows === undefined) {
      rows = this.promptRows(cell.markdown, width, theme, cell.timestamp).map(
        closeOpenStyles,
      );
      this.storeLines(cell, width, theme, rows, stamp);
    }
    out.push(...rows);
    this.renderImages(out, cell.images, width, theme, cell.id);
    return cell.images === undefined || cell.images.length === 0;
  }

  private renderPrompt(
    out: string[],
    markdown: string,
    width: number,
    theme: TuiTheme,
    images?: readonly LaneImagePart[],
    cellId?: string,
    timestamp?: number,
  ): void {
    out.push(...this.promptRows(markdown, width, theme, timestamp));
    this.renderImages(out, images, width, theme, cellId ?? '');
  }

  private promptRows(
    markdown: string,
    width: number,
    theme: TuiTheme,
    timestamp?: number,
  ): string[] {
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
    const lines = text === '' ? [''] : wrapStyled(text, room);
    return lines.map((line, index) => {
      const left = `${edge}${body(line)}`;
      const row =
        index === 0 && stamp !== ''
          ? leftRight(left, `${ui.fg('fg2')(stamp)} `, width)
          : left;
      return fillLine(ui, row, width, 'bg2');
    });
  }

  // Reasoning collapses to its first sentence; ^X shows
  // all of it, italic, behind the gutter.
  private thinking(
    cell: TranscriptEntry,
    width: number,
    theme: TuiTheme,
    expanded: boolean,
  ): string[] {
    const ui = theme.ui;
    const muted = ui.style({ fg: 'fg2', italic: true });
    const label =
      cell.durationMs === undefined
        ? 'thinking'
        : `thought for ${formatThinkingTime(cell.durationMs)}`;
    const mark = `  ${ui.fg('fg2')(THINKING_MARK)} `;
    if (expanded) {
      const out = [fit(`${mark}${ui.fg('fg2')(label)}`, width)];
      const gutter = `  ${ui.fg('fg3')('│')} `;
      const room = Math.max(1, width - 4);
      for (const line of cell.markdown.split('\n')) {
        for (const row of wrapStyled(line, room)) {
          out.push(fit(`${gutter}${muted(row)}`, width));
        }
      }
      return out;
    }
    const first = firstSentence(cell.markdown);
    const key = this.expandKey?.() ?? '^X';
    const left = `${mark}${muted(first === '' ? label : `${label} — ${first}`)}`;
    const right = key === '' ? '' : `${ui.fg('fg3')(`${key} expand`)} `;
    return [
      right !== '' && visibleWidth(left) + 2 + visibleWidth(right) <= width
        ? leftRight(left, right, width)
        : fit(left, width),
    ];
  }

  // A call and its result as one card.
  private card(
    call: TranscriptEntry | undefined,
    result: TranscriptEntry | undefined,
    width: number,
    theme: TuiTheme,
    expanded: boolean,
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
        ...(result?.display === undefined ? {} : { display: result.display }),
        ...(state?.durationMs === undefined
          ? {}
          : { durationMs: state.durationMs }),
        ...(state?.runningMs === undefined
          ? {}
          : { runningMs: state.runningMs }),
        ...(state?.waiting === true ? { waiting: true } : {}),
        expanded,
        expandKey: this.expandKey?.() ?? '^X',
      },
      width,
    );
  }

  // One attached image under the prompt text. Protocol lines are
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

  // A compaction summary: collapsed shows the first rows behind a
  // gutter and says what it hides; expanded wraps everything.
  private renderBlock(
    out: string[],
    lines: string[],
    width: number,
    theme: TuiTheme,
    expanded: boolean,
  ): void {
    const ui = theme.ui;
    const gutter = `  ${ui.fg('fg3')('│')} `;
    const bodyWidth = Math.max(1, width - visibleWidth(gutter));
    const shown = expanded ? lines : lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
    let clipped = false;
    for (const line of shown) {
      if (expanded) {
        for (const row of wrapStyled(line, bodyWidth)) {
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
  // TUI polish: the welcome block at the top of the document, the prompt
  // echoed before the lane commits it, and the expand-all toggle.
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
      // Diff by id and keep the object of every unchanged cell.
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
