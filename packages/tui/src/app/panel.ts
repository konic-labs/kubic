// The panel row: the diff panel (this run's changes, Ctrl-O) and the journal
// panel (the whole session, Ctrl-R). Both stay mounted and keep their rows;
// the layout hides the row entirely while the mode is 'closed', so a keypress
// never leaves blank space behind.
import type { Component } from '../tui-boundary.js';
import { ScrollView } from '../tui-boundary.js';
import {
  DiffPanel,
  type JournalChangeLike,
  JournalPanel,
  type PanelMode,
} from '../view-panel.js';
import type { JournalFilterLike } from './types.js';

export class PanelController {
  readonly diffPanel = new DiffPanel();
  readonly journalPanel = new JournalPanel();
  mode: PanelMode = 'closed';
  // The panel body is a ScrollView over whichever panel is open,
  // so a multi-file or long change is reachable (the wheel and the panel's
  // own keys move it). The row component must BE the ScrollView — the layout
  // engine sizes a scroll node itself, exactly as the transcript row does.
  readonly scroll: ScrollView;
  // The file the diff panel is showing. `file k/N` lives on each
  // file's own header line, and alt+up / alt+down cycle the files, so the
  // header always names the file the viewport was last moved to.
  private file = 0;

  constructor() {
    const document: Component = {
      render: (width: number): string[] =>
        this.mode === 'diff'
          ? this.diffPanel.lines(width)
          : this.journalPanel.lines(width),
      invalidate: (): void => {
        this.diffPanel.invalidate();
        this.journalPanel.invalidate();
      },
    };
    this.scroll = new ScrollView(document, {
      // No follow: the operator's viewport stays where they left it while the
      // run keeps appending journal rows.
      follow: 'none',
      scrollbar: 'auto',
    });
  }

  isOpen(): boolean {
    return this.mode !== 'closed';
  }

  // The one place the panel mode is written (the Ctrl-O/Ctrl-R toggles and
  // the `openPanel` API both go through it), so the reset below cannot be
  // skipped on the operator's real open path.
  set(next: PanelMode): void {
    this.mode = next;
    this.file = 0;
    this.scroll.scrollTo(0);
  }

  // Ctrl-O / Ctrl-R: the key opens its panel, or closes it when it is open.
  toggle(target: 'diff' | 'journal'): void {
    this.set(this.mode === target ? 'closed' : target);
  }

  // Cycle the diff panel's files (wrapping); false when there is nothing to
  // cycle (panel closed, journal panel, no rows).
  jumpFile(delta: number): boolean {
    if (this.mode !== 'diff') return false;
    const offsets = this.diffPanel.fileOffsets();
    if (offsets.length === 0) return false;
    this.file = (this.file + delta + offsets.length) % offsets.length;
    this.scroll.scrollTo(offsets[this.file] ?? 0);
    return true;
  }

  // alt+up / alt+down: the diff panel's files, else a page of the journal
  // panel — one row less than the visible body so the jump never loses the
  // operator's place.
  step(delta: number): void {
    if (this.jumpFile(delta)) return;
    this.scroll.scrollBy(delta * Math.max(1, this.scroll.viewportHeight - 1));
  }

  setChanges(rows: ReadonlyArray<JournalChangeLike>): void {
    this.diffPanel.setChanges(rows);
    this.journalPanel.setChanges(rows);
  }

  setFilter(filter: JournalFilterLike): void {
    this.journalPanel.setFilter(filter);
  }

  // The session's panels start over: closed and empty.
  reset(): void {
    this.mode = 'closed';
    this.diffPanel.setChanges([]);
    this.journalPanel.setChanges([]);
    this.diffPanel.setToolCall(null);
  }
}
