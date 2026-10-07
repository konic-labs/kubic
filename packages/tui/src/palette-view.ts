// The ^P palette's overlay.
// Pi's Input owns the query (typing, paste, the kill ring, the IME cursor);
// ui/palette.ts owns everything else. The app routes keys here while the
// palette is open: `↑↓` move (wrapping across the groups), `tab`/`shift+tab`
// focus a group, `→` toggles the details footer, `⏎` runs the selected row
// and `esc` closes. Keys that would move the query's cursor away from its
// end (where the palette draws it) are ignored.

import type { UiTheme } from '../../core/src/ui/style.js';
import { tuiTheme } from './theme.js';
import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  visibleWidth,
} from './tui-boundary.js';
import {
  createPalette,
  cyclePaletteGroup,
  movePalette,
  type PaletteItem,
  type PaletteState,
  paletteResultCount,
  renderPalette,
  selectedPaletteItem,
  setPaletteItems,
  setPaletteQuery,
  togglePaletteDetails,
} from './ui/palette.js';

export interface PaletteViewOptions {
  readonly items: readonly PaletteItem[];
  /** The palette key's cap for the title (`^P`). */
  readonly keyLabel: string;
  /** Rows the overlay may take right now. */
  readonly maxRows: () => number;
  readonly onRun: (item: PaletteItem) => void;
  readonly onClose: () => void;
  readonly ui?: () => UiTheme;
}

const CURSOR_KEYS: ReadonlyArray<Parameters<typeof matchesKey>[1]> = [
  'left',
  'home',
  'end',
  'ctrl+a',
  'ctrl+e',
  'ctrl+b',
];

export class PaletteView implements Component, Focusable {
  private readonly input = new Input({ prompt: '' });
  private readonly options: PaletteViewOptions;
  private state: PaletteState;

  constructor(options: PaletteViewOptions) {
    this.options = options;
    this.state = createPalette(options.items);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  getState(): PaletteState {
    return this.state;
  }

  /** More rows (sessions, models) arrived: the selection stays put. */
  setItems(items: readonly PaletteItem[]): void {
    this.state = setPaletteItems(this.state, items);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.state = movePalette(this.state, -1);
    } else if (matchesKey(data, 'down')) {
      this.state = movePalette(this.state, 1);
    } else if (matchesKey(data, 'shift+tab')) {
      this.state = cyclePaletteGroup(this.state, -1);
    } else if (matchesKey(data, 'tab')) {
      this.state = cyclePaletteGroup(this.state, 1);
    } else if (matchesKey(data, 'right')) {
      this.state = togglePaletteDetails(this.state);
    } else if (matchesKey(data, 'enter')) {
      const item = selectedPaletteItem(this.state);
      if (item !== undefined) this.options.onRun(item);
    } else if (matchesKey(data, 'escape')) {
      this.options.onClose();
    } else if (!CURSOR_KEYS.some((key) => matchesKey(data, key))) {
      this.input.handleInput(data);
      this.state = setPaletteQuery(this.state, this.input.getValue());
    }
  }

  render(width: number): string[] {
    const ui = (this.options.ui ?? (() => tuiTheme().ui))();
    const count = paletteResultCount(this.state);
    const label = `${count} result${count === 1 ? '' : 's'} `;
    // The query row: ` › `, the field, a gap, the count, inside the frame.
    const room = Math.max(
      1,
      Math.floor(width) - 2 - 3 - visibleWidth(label) - 1,
    );
    return renderPalette(ui, this.state, width, {
      input: this.input.render(room)[0] ?? '',
      maxRows: this.options.maxRows(),
      keyLabel: this.options.keyLabel,
    });
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
