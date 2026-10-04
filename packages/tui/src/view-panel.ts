// Inspectable panel body for the diff and journal views (issue #96; §17).
// The panel is the surface half of the two views: `DiffView` renders one
// file's effects, `JournalView` renders the session journal, and this module
// owns which of them is on screen, the multi-file document each panel
// produces (issue #301) plus the sanitisation of the journal rows that feed
// them.
//
// Sanitisation belongs HERE, at ingress (issue #88's finding, applied to the
// §17 list): journal rows come from tool calls — a path, an agent id and a
// tool-call id are model-supplied strings, and the before/after bodies are
// file content a tool read off disk. Whatever the model wrote into a file is
// therefore untrusted terminal content, and it must be cleaned before any
// render function sees it (renderDiffLines/renderJournalLines render the text
// they are handed and their own tests pin them at that level — they are not
// the choke point).
//
// Presentation only (§66): the panels hold copied rows and a filter. They
// know nothing about lanes, hosts or the approval policy.

import type { DiffFileChange, DiffOp } from './diff-view.js';
import { renderDiffLines } from './diff-view.js';
import type { JournalFilter } from './journal-view.js';
import { JournalView } from './journal-view.js';
import { sanitizeLaneText } from './lane-cells.js';
import type { Component } from './tui-boundary.js';

export type PanelMode = 'closed' | 'diff' | 'journal';

// Structural journal-row shape: the fields the panels read, mirroring exec's
// FileChange (packages/exec/src/journal-diff.ts) WITHOUT importing it — the
// tui package must never import exec/worker/host implementation (dep-lint).
// `before`/`after` are nullable exactly like FileChange's.
export interface JournalChangeLike {
  readonly path: string;
  readonly op: DiffOp;
  readonly agentId: string;
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
export const PANEL_EMPTY_LINE = 'no changes';

// Sanitise a journal row before it reaches a render function. Every string
// field a tool call or the journal store can carry is cleaned; the non-string
// fields are carried through untouched. A null body stays null —
// `create`/`delete` legitimately have one null side, and diff-view.ts renders
// its own placeholder for those.
export function sanitizeJournalChange(
  change: JournalChangeLike,
): JournalChangeLike {
  return {
    ...change,
    path: sanitizeLaneText(change.path),
    agentId: sanitizeLaneText(change.agentId),
    toolCallId:
      change.toolCallId === null ? null : sanitizeLaneText(change.toolCallId),
    sessionId: sanitizeLaneText(change.sessionId),
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

  constructor(rows: ReadonlyArray<JournalChangeLike> = []) {
    this.rows = rows.map(sanitizeJournalChange);
    this.selected = null;
    this.fallback = null;
  }

  setChanges(rows: ReadonlyArray<JournalChangeLike>): void {
    this.rows = rows.map(sanitizeJournalChange);
  }

  setToolCall(toolCallId: string | null): void {
    // Sanitized on the same basis as the rows: a selection that arrived with
    // control sequences must still compare equal to the row it names, or the
    // panel would silently show `no changes`.
    this.selected = toolCallId === null ? null : sanitizeLaneText(toolCallId);
  }

  // The run's current tool call, used only while no explicit selection is
  // pinned. Called by the app on every tool-start/tool-end event.
  followToolCall(toolCallId: string | null): void {
    this.fallback = toolCallId === null ? null : sanitizeLaneText(toolCallId);
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
    // Issue #311: following the run, the call the run last touched may have
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

  // Issue #301: the WHOLE document — every visible row with its own header
  // and CLI-identical block, in journal order. The panel row is a ScrollView
  // over this, so nothing is dropped and a long change is reachable by
  // scrolling; `render` returns the same lines for callers that render the
  // panel on its own.
  lines(width: number): string[] {
    const visible = this.visibleRows();
    if (visible.length === 0) return [PANEL_EMPTY_LINE];
    return visible.flatMap((row, index) =>
      renderDiffLines(row as DiffFileChange, {
        width,
        fileOrdinal: { index: index + 1, total: visible.length },
      }),
    );
  }

  // Issue #301: the line offset of each file's header in `lines(width)` — the
  // jump targets for alt+up/alt+down. Width truncation never adds or removes
  // a line, so the count is width-independent.
  fileOffsets(): number[] {
    const offsets: number[] = [];
    let at = 0;
    for (const row of this.visibleRows()) {
      offsets.push(at);
      at += renderDiffLines(row as DiffFileChange).length;
    }
    return offsets;
  }

  render(width: number): string[] {
    return this.lines(width);
  }

  invalidate(): void {}
}

// `J`-reachable journal view: the whole session journal, with the filters
// journal-view.ts already implements (exact path / agent match).
export class JournalPanel implements Component {
  private readonly view: JournalView;
  private rows: JournalChangeLike[];
  private filter: JournalFilter;

  constructor(rows: ReadonlyArray<JournalChangeLike> = []) {
    this.rows = rows.map(sanitizeJournalChange);
    this.filter = {};
    this.view = new JournalView([], {});
    this.paint();
  }

  setChanges(rows: ReadonlyArray<JournalChangeLike>): void {
    this.rows = rows.map(sanitizeJournalChange);
    this.paint();
  }

  setFilter(filter: JournalFilter): void {
    this.filter = { ...filter };
    this.paint();
  }

  getFilter(): JournalFilter {
    return { ...this.filter };
  }

  visibleRows(): ReadonlyArray<JournalChangeLike> {
    return this.rows.filter(
      (row) =>
        (this.filter.path === undefined || row.path === this.filter.path) &&
        (this.filter.agent === undefined || row.agentId === this.filter.agent),
    );
  }

  render(width: number): string[] {
    return this.view.render(width);
  }

  // Issue #301: the same document contract as DiffPanel.lines — the panel row
  // is a ScrollView over this, so the journal panel's rows scroll too.
  lines(width: number): string[] {
    return this.view.render(width);
  }

  invalidate(): void {
    this.view.invalidate();
  }

  private paint(): void {
    this.view.setChanges(this.visibleRows());
  }
}
