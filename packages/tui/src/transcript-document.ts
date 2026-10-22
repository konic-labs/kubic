// The transcript document: every cell rendered to rows, with each cell's
// markdown and finished rows cached while its text, width and theme are
// unchanged, so a steady frame parses nothing.

import type { LaneImagePart } from '@kubic/core/presentation';
import { FOCUS_EDGE, PROSE } from '@kubic/core/ui/glyphs';
import { createAttachmentComponent } from './attachments.js';
import { pushBlockRows, thinkingRows, toolCardRows } from './cell-rows.js';
import type { TuiTheme } from './theme.js';
import { tuiTheme } from './theme.js';
import type {
  ToolCallState,
  TranscriptBlock,
  TranscriptBlockKind,
  TranscriptEntry,
} from './transcript-entry.js';
import {
  cellIdOf,
  fit,
  formatPromptTime,
  imageCellIdOf,
  markdownThemeFor,
  PROMPT_MARK,
  plainText,
  queuedLine,
  renderReceipt,
  stripPrefix,
  themeKey,
  withEdge,
} from './transcript-text.js';
import type { Component } from './tui-boundary.js';
import { getCapabilities, Markdown, visibleWidth } from './tui-boundary.js';
import { linkFileReferences } from './ui/file-links.js';
import { closeOpenStyles, leftRight, wrapStyled } from './ui/line.js';
import { fillLine } from './ui/surface.js';

// The rendered document: welcome block, then one block per cell. Pure over
// its fields — the active theme is read per render, so a theme set after
// construction (the composition root) takes effect on the next frame.
export class TranscriptDocument implements Component {
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
        out.push(
          ...toolCardRows(
            cell,
            result,
            w,
            theme,
            expanded,
            this.toolState,
            () => this.keyHint(),
          ),
        );
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
        pushBlockRows(out, cell.markdown.split('\n'), w, theme, expanded, () =>
          this.keyHint(),
        );
        return { kind: 'compaction', copy: cell.markdown };
      }
      case 'thinking': {
        gap();
        out.push(
          ...thinkingRows(cell, w, theme, expanded, () => this.keyHint()),
        );
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
        out.push(
          ...toolCardRows(
            undefined,
            cell,
            w,
            theme,
            expanded,
            this.toolState,
            () => this.keyHint(),
          ),
        );
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

  // The key that expands a collapsed block, as the hints name it.
  private keyHint(): string {
    return this.expandKey?.() ?? '^X';
  }
}
