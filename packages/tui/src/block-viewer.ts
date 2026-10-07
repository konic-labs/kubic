// The block viewer: one transcript block
// whole — the full tool output or diff, the whole answer or thinking — in a
// framed overlay that scrolls on its own: `↑↓`/`j k` a row, `PgUp/PgDn` a
// page, `g`/`G` the ends, `y` copies, `esc` closes. Its rows come from the
// transcript (rendered expanded at the viewer's width).

import type { UiTheme } from '../../core/src/ui/style.js';
import { tuiTheme } from './theme.js';
import { type Component, matchesKey, visibleWidth } from './tui-boundary.js';
import { exactWidth, fitLine } from './ui/line.js';

export interface BlockViewerOptions {
  /** What the frame names (`bash npm test`, `answer`). */
  readonly title: string;
  /** The block whole at a width. */
  readonly lines: (width: number) => string[];
  /** Rows the overlay may take right now. */
  readonly maxRows: () => number;
  readonly onCopy: () => void;
  readonly onClose: () => void;
  readonly ui?: () => UiTheme;
}

export class BlockViewer implements Component {
  private readonly options: BlockViewerOptions;
  private top = 0;
  private lastRows = 0;
  private lastHeight = 1;

  constructor(options: BlockViewerOptions) {
    this.options = options;
  }

  private scroll(next: number): void {
    const max = Math.max(0, this.lastRows - this.lastHeight);
    this.top = Math.min(max, Math.max(0, next));
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || data === 'q') {
      this.options.onClose();
    } else if (data === 'y') {
      this.options.onCopy();
    } else if (matchesKey(data, 'up') || data === 'k') {
      this.scroll(this.top - 1);
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.scroll(this.top + 1);
    } else if (matchesKey(data, 'pageUp')) {
      this.scroll(this.top - this.lastHeight);
    } else if (matchesKey(data, 'pageDown')) {
      this.scroll(this.top + this.lastHeight);
    } else if (matchesKey(data, 'home') || data === 'g') {
      this.scroll(0);
    } else if (matchesKey(data, 'end') || data === 'G') {
      this.scroll(this.lastRows);
    }
  }

  render(width: number): string[] {
    const ui = (this.options.ui ?? (() => tuiTheme().ui))();
    const w = Math.max(10, Math.floor(width));
    const inner = w - 4;
    const rows = this.options.lines(inner);
    const height = Math.max(1, Math.floor(this.options.maxRows()) - 3);
    this.lastRows = rows.length;
    this.lastHeight = height;
    this.scroll(this.top);
    const border = ui.fg('fg1');
    const shown = rows.slice(this.top, this.top + height);
    const position =
      rows.length <= height
        ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
        : `${this.top + 1}–${this.top + shown.length} of ${rows.length}`;
    const title = ui.style({ fg: 'fg0', bold: true })(
      fitLine(this.options.title, Math.max(1, w - 12 - position.length)),
    );
    const label = ui.fg('fg2')(position);
    const dashes = Math.max(
      1,
      w - 6 - visibleWidth(title) - visibleWidth(label),
    );
    const top = `${border('┌─ ')}${title}${border(` ${'─'.repeat(dashes)} `)}${label}${border('┐')}`;
    const keys = ` ${ui.fg('fg1')('↑↓')} ${ui.fg('fg2')('scroll')}   ${ui.fg('fg1')('y')} ${ui.fg('fg2')('copy')}   ${ui.fg('fg1')('esc')} ${ui.fg('fg2')('close')} `;
    const bottomDashes = Math.max(0, w - 3 - visibleWidth(keys));
    const bottom = `${border('└─')}${keys}${border(`${'─'.repeat(bottomDashes)}┘`)}`;
    return [
      fitLine(top, w),
      ...shown.map(
        (line) => `${border('│')} ${exactWidth(line, inner)} ${border('│')}`,
      ),
      fitLine(bottom, w),
    ];
  }

  invalidate(): void {}
}
