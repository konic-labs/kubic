// The panel row: the diff panel (this run's changes, Ctrl-O) and the journal
// panel (the whole session, Ctrl-R). Both stay mounted and keep their rows;
// the layout hides the row entirely while the mode is 'closed', so a keypress
// never leaves blank space behind. The open panel sits in a light box: the
// title rule names it and counts its files and lines, the body scrolls
// between the edges, and the closing rule says where the viewport is.
import { renderCounts } from '../diff-view.js';
import { PANEL_MAX_ROWS } from '../layout.js';
import { tuiTheme } from '../theme.js';
import type { Component } from '../tui-boundary.js';
import { ScrollView } from '../tui-boundary.js';
import { frameInnerWidth, frameLines } from '../ui/frame.js';
import { exactWidth } from '../ui/line.js';
import {
  DiffPanel,
  type JournalChangeLike,
  JournalPanel,
  type PanelMode,
} from '../view-panel.js';
import type { JournalFilterLike } from './types.js';

// What each panel is called in its title rule.
const PANEL_TITLE: Record<
  Exclude<PanelMode, 'closed'>,
  readonly [string, string]
> = {
  diff: ['Diff', 'last change'],
  journal: ['Journal', 'this session'],
};

// The body's height: half the terminal less the rows around it, so the
// transcript, the editor and the status line keep theirs; PANEL_MAX_ROWS
// when the height is unknown.
/** @internal */
export function panelBodyRows(terminalRows: number | undefined): number {
  if (terminalRows === undefined) return PANEL_MAX_ROWS;
  return Math.max(
    1,
    Math.min(PANEL_MAX_ROWS, Math.floor(terminalRows / 2) - 4),
  );
}

// The panel's scroll body. The layout measures a row by rendering it, and a
// ScrollView renders its whole document, so the measure is capped here; the
// scrolling itself lays out the full document.
class PanelScroll extends ScrollView {
  private readonly rows: () => number;

  constructor(document: Component, rows: () => number) {
    super(document, {
      // No follow: the operator's viewport stays where they left it while the
      // run keeps appending journal rows.
      follow: 'none',
      // The closing rule reports the position, so the right edge stays a
      // clean line.
      scrollbar: 'hidden',
    });
    this.rows = rows;
  }

  render(width: number): string[] {
    return super.render(width).slice(0, this.rows());
  }
}

// A one-row component over a render function.
function rowComponent(render: (width: number) => string): Component {
  return {
    render: (width: number): string[] => [render(width)],
    invalidate: (): void => {},
  };
}

export class PanelController {
  readonly diffPanel = new DiffPanel();
  readonly journalPanel = new JournalPanel();
  mode: PanelMode = 'closed';
  // The panel body is a ScrollView over whichever panel is open,
  // so a multi-file or long change is reachable (the wheel and the panel's
  // own keys move it). The row component must BE the ScrollView — the layout
  // engine sizes a scroll node itself, exactly as the transcript row does.
  readonly scroll: PanelScroll;
  // The box's title rule and closing rule, rows of their own around the
  // scrolling body.
  readonly top: Component;
  readonly bottom: Component;
  // The body's line count at the last render, for the closing rule.
  private contentLines = 0;
  // The file the diff panel is showing. `file k/N` lives on each
  // file's own header line, and alt+up / alt+down cycle the files, so the
  // header always names the file the viewport was last moved to.
  private file = 0;

  constructor(terminalRows: () => number | undefined = () => undefined) {
    const document: Component = {
      render: (width: number): string[] => this.body(width),
      invalidate: (): void => {
        this.diffPanel.invalidate();
        this.journalPanel.invalidate();
      },
    };
    this.scroll = new PanelScroll(document, () =>
      panelBodyRows(terminalRows()),
    );
    this.top = rowComponent((width) => this.rule(width, 'top'));
    this.bottom = rowComponent((width) => this.rule(width, 'bottom'));
  }

  // The open panel's document between the box's edges.
  private body(width: number): string[] {
    const ui = tuiTheme().ui;
    const inner = frameInnerWidth(width);
    const lines =
      this.mode === 'diff'
        ? this.diffPanel.lines(inner)
        : this.journalPanel.lines(inner);
    this.contentLines = lines.length;
    const edge = ui.fg('fg3')('│');
    return lines.map((line) => `${edge} ${exactWidth(line, inner)} ${edge}`);
  }

  private rule(width: number, which: 'top' | 'bottom'): string {
    if (this.mode === 'closed') return '';
    const ui = tuiTheme().ui;
    if (which === 'top') {
      const [name, scope] = PANEL_TITLE[this.mode];
      const summary =
        this.mode === 'diff'
          ? this.diffPanel.summary()
          : this.journalPanel.summary();
      const files = `${summary.files} file${summary.files === 1 ? '' : 's'}`;
      const [top] = frameLines(ui, [], width, {
        title: `${ui.style({ fg: 'accent', bold: true })(name)}${ui.fg('fg2')(` · ${scope}`)}`,
        ...(summary.files === 0
          ? {}
          : {
              rightLabel: `${ui.fg('fg1')(files)}  ${renderCounts(ui, summary)}`,
            }),
      });
      return top ?? '';
    }
    // Where the viewport is, once the body does not fit.
    const view = this.scroll.viewportHeight;
    const first = this.scroll.scrollTop + 1;
    const last = Math.min(this.contentLines, this.scroll.scrollTop + view);
    const [, bottom] = frameLines(ui, [], width, {
      ...(this.contentLines > view && view > 0
        ? {
            footerRight: ui.fg('fg2')(
              `${first}–${last} of ${this.contentLines}`,
            ),
          }
        : {}),
    });
    return bottom ?? '';
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
