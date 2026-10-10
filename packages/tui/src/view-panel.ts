// Inspectable panel bodies for the diff and journal views.
// `renderChange` (diff-view.ts) draws one file's section and
// `renderJournalLines` (journal-view.ts) the session journal; this module
// owns the multi-file document each panel produces plus the sanitisation of
// the journal rows that feed them. The frame around the body is the panel
// row's (app/panel.ts).
//
// Sanitisation belongs HERE, at ingress (applied to the
// list): journal rows come from tool calls — a path and a tool-call id are
// model-supplied strings, and the before/after bodies are
// file content a tool read off disk. Whatever the model wrote into a file is
// therefore untrusted terminal content, and it must be cleaned before any
// render function sees it (the render functions draw the text they are
// handed and their own tests pin them at that level — they are not the
// choke point).
//
// Presentation only: the panels hold copied rows and a filter. They
// know nothing about lanes, hosts or the approval policy.

import type { UiTheme } from '@kubic/core/ui/style';
import {
  type ChangeCounts,
  changeRows,
  type DiffFileChange,
  type DiffOp,
  renderChange,
} from './diff-view.js';
import type { JournalFilter } from './journal-view.js';
import { renderJournalLines, totalCounts } from './journal-view.js';
import { sanitizeLaneText } from './lane-text.js';
import { tuiTheme } from './theme.js';
import type { Component } from './tui-boundary.js';
import { fitLine } from './ui/line.js';

export type PanelMode = 'closed' | 'diff' | 'journal';

// Structural journal-row shape: the fields the panels read, mirroring exec's
// FileChange (packages/exec/src/journal/diff.ts) WITHOUT importing it — the
// tui package must never import exec/agent/host implementation (dep-lint).
// `before`/`after` are nullable exactly like FileChange's.
export interface JournalChangeLike {
  readonly path: string;
  readonly op: DiffOp;
  readonly toolCallId: string | null;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly unattributed: boolean;
  readonly reversible: boolean;
  readonly before: string | null;
  readonly after: string | null;
}

// An empty panel is not an empty frame: `kubic diff` prints `no changes` and
// the panel says the same, so a keypress never yields a blank rectangle the
// operator cannot tell apart from a broken view.
/** @internal */
export const PANEL_EMPTY_LINE = 'no changes';

// What a panel's title rule reports: how many files, how many lines.
export interface PanelSummary extends ChangeCounts {
  readonly files: number;
}

// A panel's lines (for one width and theme) and its summary, kept until the
// rows or the selection change: a steady frame re-reads them instead of
// re-hunking every file.
class PanelCache {
  private width = -1;
  private ui: UiTheme | undefined;
  private lines: string[] = [];
  private counted: PanelSummary | undefined;

  get(width: number, render: (ui: UiTheme) => string[]): string[] {
    const ui = tuiTheme().ui;
    if (width !== this.width || ui !== this.ui) {
      this.lines = render(ui);
      this.width = width;
      this.ui = ui;
    }
    return this.lines;
  }

  summary(rows: ReadonlyArray<DiffFileChange>): PanelSummary {
    this.counted ??= { files: rows.length, ...totalCounts(rows) };
    return this.counted;
  }

  clear(): void {
    this.width = -1;
    this.counted = undefined;
  }
}

// One file's section height: its header band plus its rows, or its note.
function sectionHeight(change: DiffFileChange): number {
  const { rows, note } = changeRows(change);
  return 1 + (note === undefined ? rows.length : 1);
}

// Sanitise a journal row before it reaches a render function. The fields are
// picked one by one, so a field the panels do not name (a stored attribution,
// say) never reaches a render function at all. Every string field is cleaned;
// the non-string fields are copied as they are. A null body stays null —
// `create`/`delete` legitimately have one null side, and diff-view.ts renders
// its own placeholder for those.
function sanitizeJournalChange(change: JournalChangeLike): JournalChangeLike {
  return {
    path: sanitizeLaneText(change.path),
    op: change.op,
    toolCallId:
      change.toolCallId === null ? null : sanitizeLaneText(change.toolCallId),
    sessionId: sanitizeLaneText(change.sessionId),
    timestamp: change.timestamp,
    unattributed: change.unattributed,
    reversible: change.reversible,
    before: change.before === null ? null : sanitizeLaneText(change.before),
    after: change.after === null ? null : sanitizeLaneText(change.after),
  };
}

// `D`-reachable diff view: the current run's own changes, filtered to the
// selected tool call. `null` selection means "follow the run" — the app
// resolves it to the tool call the run most recently started or finished, so
// the panel shows THIS run's effects by default instead of whatever the
// journal happens to hold first (the journal spans sessions; the diff panel
// does not).
export class DiffPanel implements Component {
  private rows: JournalChangeLike[];
  private selected: string | null;
  private fallback: string | null;
  private readonly cache = new PanelCache();

  constructor(rows: ReadonlyArray<JournalChangeLike> = []) {
    this.rows = rows.map(sanitizeJournalChange);
    this.selected = null;
    this.fallback = null;
  }

  setChanges(rows: ReadonlyArray<JournalChangeLike>): void {
    this.rows = rows.map(sanitizeJournalChange);
    this.cache.clear();
  }

  setToolCall(toolCallId: string | null): void {
    // Sanitized on the same basis as the rows: a selection that arrived with
    // control sequences must still compare equal to the row it names, or the
    // panel would silently show `no changes`.
    this.selected = toolCallId === null ? null : sanitizeLaneText(toolCallId);
    this.cache.clear();
  }

  // The run's current tool call, used only while no explicit selection is
  // pinned. Called by the app on every tool-start/tool-end event.
  followToolCall(toolCallId: string | null): void {
    const next = toolCallId === null ? null : sanitizeLaneText(toolCallId);
    if (next === this.fallback) return;
    this.fallback = next;
    this.cache.clear();
  }

  getToolCall(): string | null {
    return this.selected ?? this.fallback;
  }

  // The rows this panel renders, in journal order. Public so tests assert the
  // selection rule directly instead of reverse-engineering a frame.
  visibleRows(): ReadonlyArray<JournalChangeLike> {
    const effective = this.getToolCall();
    if (effective === null) return this.rows;
    const matched = this.rows.filter((row) => row.toolCallId === effective);
    // An explicit pin is honoured exactly: an empty result says `no changes`.
    if (matched.length > 0 || this.selected !== null) return matched;
    // Following the run, the call the run last touched may have
    // written nothing (a read, a listing). The panel then shows the most
    // recent change instead of blanking. A `bash` write is journaled only by
    // the sweep, as unattributed rows (toolCallId null) that share one
    // timestamp per sweep: they are candidates too, grouped by that sweep, or
    // a shell edit would leave the panel on `no changes`.
    let latest: JournalChangeLike | undefined;
    for (const row of this.rows) {
      if (latest === undefined || row.timestamp >= latest.timestamp)
        latest = row;
    }
    if (latest === undefined) return [];
    const { toolCallId: id, timestamp } = latest;
    return this.rows.filter(
      (row) =>
        row.toolCallId === id && (id !== null || row.timestamp === timestamp),
    );
  }

  // The WHOLE document — every visible row as its own section (a header
  // band, then the hunks `kubic diff` prints for it), a blank row between
  // files, in journal order. The panel row is a ScrollView over this, so
  // nothing is dropped and a long change is reachable by scrolling.
  lines(width: number): string[] {
    return this.cache.get(width, (ui) => {
      const visible = this.visibleRows();
      if (visible.length === 0) {
        return [fitLine(ui.fg('fg2')(PANEL_EMPTY_LINE), width)];
      }
      return visible.flatMap((row, index) => [
        ...(index === 0 ? [] : ['']),
        ...renderChange(ui, row as DiffFileChange, width, {
          ordinal: { index: index + 1, total: visible.length },
        }),
      ]);
    });
  }

  // The line offset of each file's header in `lines(width)` — the
  // jump targets for alt+up/alt+down. Rows are fitted, never wrapped, so the
  // offsets are width-independent.
  fileOffsets(): number[] {
    const offsets: number[] = [];
    let at = 0;
    for (const row of this.visibleRows()) {
      offsets.push(at);
      at += sectionHeight(row as DiffFileChange) + 1;
    }
    return offsets;
  }

  summary(): PanelSummary {
    return this.cache.summary(this.visibleRows());
  }

  render(width: number): string[] {
    return this.lines(width);
  }

  invalidate(): void {
    this.cache.clear();
  }
}

// `J`-reachable journal view: the whole session journal, with the filters
// journal-view.ts already implements (exact path match).
export class JournalPanel implements Component {
  private rows: JournalChangeLike[];
  private filter: JournalFilter;
  private readonly cache = new PanelCache();

  constructor(rows: ReadonlyArray<JournalChangeLike> = []) {
    this.rows = rows.map(sanitizeJournalChange);
    this.filter = {};
  }

  setChanges(rows: ReadonlyArray<JournalChangeLike>): void {
    this.rows = rows.map(sanitizeJournalChange);
    this.cache.clear();
  }

  setFilter(filter: JournalFilter): void {
    this.filter = { ...filter };
    this.cache.clear();
  }

  getFilter(): JournalFilter {
    return { ...this.filter };
  }

  visibleRows(): ReadonlyArray<JournalChangeLike> {
    return this.rows.filter(
      (row) => this.filter.path === undefined || row.path === this.filter.path,
    );
  }

  render(width: number): string[] {
    return this.lines(width);
  }

  // The same document contract as DiffPanel.lines — the panel row
  // is a ScrollView over this, so the journal panel's rows scroll too.
  lines(width: number): string[] {
    return this.cache.get(width, (ui) =>
      renderJournalLines(ui, this.visibleRows(), width),
    );
  }

  summary(): PanelSummary {
    return this.cache.summary(this.visibleRows());
  }

  invalidate(): void {
    this.cache.clear();
  }
}
