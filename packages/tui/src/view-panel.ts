// Inspectable panel body for the diff and journal views (issue #96; §17).
// The panel is the surface half of the two views: `DiffView` renders one
// tool call's effects, `JournalView` renders the session journal, and this
// module owns which of them is on screen plus the sanitisation of the
// journal rows that feed them.
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
import { DiffView } from './diff-view.js';
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

// The panel row is PANEL_BASIS lines tall (layout.ts); the diff body clamps to
// one line less so its own "… (N more lines)" tail stays inside the row.
export const PANEL_BODY_LINES = 11;

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
    // recent call that DID change something instead of blanking.
    let latest: JournalChangeLike | undefined;
    for (const row of this.rows) {
      if (row.toolCallId === null) continue;
      if (latest === undefined || row.timestamp >= latest.timestamp)
        latest = row;
    }
    if (latest === undefined) return [];
    const id = latest.toolCallId;
    return this.rows.filter((row) => row.toolCallId === id);
  }

  render(width: number): string[] {
    const visible = this.visibleRows();
    const first = visible[0];
    if (first === undefined) return [PANEL_EMPTY_LINE];
    // One DiffView per selected call: the view renders a single change and
    // the selection is the filter (the journal panel is the multi-file
    // surface). A fresh instance per render keeps the two panels from sharing
    // mutable render state.
    const view = new DiffView(first as DiffFileChange, {
      width,
      maxLines: PANEL_BODY_LINES,
    });
    return view.render(width);
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

  invalidate(): void {
    this.view.invalidate();
  }

  private paint(): void {
    this.view.setChanges(this.visibleRows());
  }
}
