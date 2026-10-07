// A "choose one" overlay: the
// model, session, theme, thinking and prompt pickers. Pi's Input owns the
// filter; ui/picker.ts owns the list. The app routes keys here while it is
// open: `↑↓` move, `⏎` chooses (or opens a folded group), `→` opens a
// folded group or steps the side control (the model picker's thinking
// level) with `←`, `esc` closes. Keys that would move the filter's cursor
// off its end are ignored.

import type { UiTheme } from '../../core/src/ui/style.js';
import { tuiTheme } from './theme.js';
import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
} from './tui-boundary.js';
import {
  createPicker,
  expandPickerGroup,
  movePicker,
  onExpandRow,
  type PickerGroup,
  type PickerRow,
  type PickerState,
  renderPicker,
  selectedPickerRow,
  setPickerQuery,
} from './ui/picker.js';

export interface PickerViewOptions {
  readonly title: string;
  readonly groups: readonly PickerGroup[];
  /** Rows the overlay may take right now. */
  readonly maxRows: () => number;
  readonly onSelect: (row: PickerRow) => void;
  readonly onClose: () => void;
  /** The selection moved (the theme picker previews it). */
  readonly onMove?: (row: PickerRow | undefined) => void;
  /** `←`/`→` on a row: the side control (the thinking level). */
  readonly onSide?: (direction: -1 | 1, row: PickerRow | undefined) => void;
  /** Lines under their own rule, for the selected row, `width` cells. */
  readonly footer?: (
    ui: UiTheme,
    row: PickerRow | undefined,
    width: number,
  ) => string[];
  readonly ui?: () => UiTheme;
}

const CURSOR_KEYS: ReadonlyArray<Parameters<typeof matchesKey>[1]> = [
  'home',
  'end',
  'ctrl+a',
  'ctrl+e',
  'ctrl+b',
  'ctrl+f',
];

export class PickerView implements Component, Focusable {
  private readonly input = new Input({ prompt: '' });
  private readonly options: PickerViewOptions;
  private state: PickerState;

  constructor(options: PickerViewOptions) {
    this.options = options;
    this.state = createPicker(options.groups);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  getState(): PickerState {
    return this.state;
  }

  selected(): PickerRow | undefined {
    return selectedPickerRow(this.state);
  }

  private move(next: PickerState): void {
    const before = selectedPickerRow(this.state);
    this.state = next;
    const after = selectedPickerRow(this.state);
    if (after !== before) this.options.onMove?.(after);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.move(movePicker(this.state, -1));
    } else if (matchesKey(data, 'down')) {
      this.move(movePicker(this.state, 1));
    } else if (matchesKey(data, 'enter')) {
      if (onExpandRow(this.state)) {
        this.move(expandPickerGroup(this.state));
        return;
      }
      const row = selectedPickerRow(this.state);
      if (row !== undefined) this.options.onSelect(row);
    } else if (matchesKey(data, 'right')) {
      if (onExpandRow(this.state)) this.move(expandPickerGroup(this.state));
      else this.options.onSide?.(1, selectedPickerRow(this.state));
    } else if (matchesKey(data, 'left')) {
      this.options.onSide?.(-1, selectedPickerRow(this.state));
    } else if (matchesKey(data, 'escape')) {
      this.options.onClose();
    } else if (!CURSOR_KEYS.some((key) => matchesKey(data, key))) {
      this.input.handleInput(data);
      this.move(setPickerQuery(this.state, this.input.getValue()));
    }
  }

  render(width: number): string[] {
    const ui = (this.options.ui ?? (() => tuiTheme().ui))();
    const results = 'type to filter ';
    // The filter row: ` › `, the field, a gap, its right label, framed.
    const room = Math.max(1, Math.floor(width) - 2 - 3 - results.length - 1);
    return renderPicker(ui, this.state, width, {
      title: this.options.title,
      input: this.input.render(room)[0] ?? '',
      maxRows: this.options.maxRows(),
      ...(this.options.footer === undefined
        ? {}
        : {
            footer: this.options.footer(
              ui,
              selectedPickerRow(this.state),
              Math.max(1, Math.floor(width) - 2),
            ),
          }),
    });
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
