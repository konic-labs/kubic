// `/tree`: the session tree in the editor's place, as pi shows its tree. It
// owns the keys while it is open. The registry's tree actions move, page,
// fold, filter, label and copy; any other key edits the search, which narrows
// the rows as it is typed. Enter goes to the selected entry, Esc clears the
// search and then closes. A label is edited in place, under the header.
import type { UiTheme } from '@kubic/core/ui/style';
import type { KeyAction, KeyRegistry } from './keybindings.js';
import {
  SessionTreeState,
  type TreeEntryLike,
  type TreeFilter,
} from './session-tree.js';
import {
  renderTreeHeader,
  renderTreeRows,
  renderTreeRule,
  type TreeHelpItem,
} from './session-tree-render.js';
import { Input, truncateToWidth } from './tui-boundary.js';

export interface SessionTreeViewOptions {
  readonly entries: readonly TreeEntryLike[];
  /** The entry the session is at. */
  readonly currentId: string | null;
  readonly maxVisible: number;
  readonly keys: KeyRegistry;
  readonly selectedId?: string;
  readonly filter?: TreeFilter;
  readonly onSelect: (entry: TreeEntryLike) => void;
  readonly onCancel: () => void;
  /** The selected entry's text, or undefined when it has none to copy. */
  readonly onCopy: (text: string | undefined) => void;
  /** A label saved (or removed, with `undefined`) for an entry. */
  readonly onLabel: (entryId: string, label: string | undefined) => void;
}

const FILTER_KEYS: ReadonlyArray<readonly [KeyAction, TreeFilter]> = [
  ['tree.filter.default', 'default'],
  ['tree.filter.noTools', 'no-tools'],
  ['tree.filter.userOnly', 'user-only'],
  ['tree.filter.labeledOnly', 'labeled-only'],
  ['tree.filter.all', 'all'],
];

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'pgup',
  pagedown: 'pgdn',
  enter: '⏎',
  escape: 'esc',
  esc: 'esc',
};

// A key as the header shows it: `^X`, `^⇧O`, `alt+←`, and a shifted letter
// as the capital it types (`L`).
function treeCap(label: string): string {
  if (label === '') return '';
  const parts = label.split('+');
  const key = parts.pop() as string;
  const base = KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const ctrl = parts.includes('ctrl') ? '^' : '';
  const shift = parts.includes('shift');
  const alt = parts.includes('alt') ? 'alt+' : '';
  if (shift && ctrl === '' && alt === '' && key.length === 1) return base;
  return `${alt}${ctrl}${shift ? '⇧' : ''}${base}`;
}

// Keys that share a modifier, as one item: `^D/T/U`, `alt+←/→`, `↑/↓`.
function joinKeys(caps: readonly string[]): string {
  if (caps.length < 2) return caps[0] ?? '';
  const prefixOf = (cap: string): string =>
    cap.startsWith('alt+') ? 'alt+' : cap.startsWith('^') ? '^' : '';
  const prefix = prefixOf(caps[0] as string);
  const rests = caps.map((cap) => cap.slice(prefix.length));
  const plain = rests.every((rest) => !/[⇧^+]/.test(rest));
  return caps.every((cap) => prefixOf(cap) === prefix) && plain
    ? `${prefix}${rests.join('/')}`
    : caps.join('/');
}

export class SessionTreeView {
  readonly state: SessionTreeState;
  private readonly options: SessionTreeViewOptions;
  // The search field: typing (any key the tree does not claim) edits it.
  private readonly search = new Input();
  private label: { readonly id: string; readonly input: Input } | undefined;

  constructor(options: SessionTreeViewOptions) {
    this.options = options;
    this.state = new SessionTreeState(options.entries, options.currentId, {
      maxVisible: options.maxVisible,
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.selectedId === undefined
        ? {}
        : { selectedId: options.selectedId }),
    });
  }

  /** The label input is open (Enter saves, Esc returns to the tree). */
  get editingLabel(): boolean {
    return this.label !== undefined;
  }

  handleKey(data: string, keyId: string | undefined): void {
    if (this.label !== undefined) {
      this.labelKey(data, keyId);
      return;
    }
    const action = this.options.keys.actionFor('tree', keyId);
    if (action === undefined || !this.act(action)) {
      this.search.handleInput(data);
      this.state.setSearch(this.search.getValue());
    }
  }

  // One tree action; false when it is not the tree's (the search gets it).
  private act(action: KeyAction): boolean {
    const state = this.state;
    switch (action) {
      case 'tree.up':
        state.step(-1);
        return true;
      case 'tree.down':
        state.step(1);
        return true;
      case 'tree.pageUp':
        state.page(-1);
        return true;
      case 'tree.pageDown':
        state.page(1);
        return true;
      case 'tree.foldOrUp':
        state.foldOrUp();
        return true;
      case 'tree.unfoldOrDown':
        state.unfoldOrDown();
        return true;
      case 'tree.select': {
        const entry = state.selected();
        if (entry !== undefined) this.options.onSelect(entry);
        return true;
      }
      case 'tree.close':
        if (state.search === '') {
          this.options.onCancel();
        } else {
          this.search.setValue('');
          state.setSearch('');
        }
        return true;
      case 'tree.copy':
        this.options.onCopy(state.selected()?.copyText);
        return true;
      case 'tree.label': {
        const entry = state.selected();
        if (entry === undefined) return true;
        const input = new Input();
        if (entry.label !== undefined) input.setValue(entry.label);
        input.focused = true;
        this.label = { id: entry.id, input };
        return true;
      }
      case 'tree.labelTime':
        state.labelTimes = !state.labelTimes;
        return true;
      case 'tree.filter.next':
        state.cycleFilter(1);
        return true;
      case 'tree.filter.previous':
        state.cycleFilter(-1);
        return true;
      default: {
        const filter = FILTER_KEYS.find(([key]) => key === action)?.[1];
        if (filter === undefined) return false;
        state.toggleFilter(filter);
        return true;
      }
    }
  }

  private labelKey(data: string, keyId: string | undefined): void {
    const open = this.label;
    if (open === undefined) return;
    if (keyId === 'enter') {
      const text = open.input.getValue().trim();
      const label = text === '' ? undefined : text;
      this.state.setLabel(open.id, label, new Date().toISOString());
      this.label = undefined;
      this.options.onLabel(open.id, label);
    } else if (keyId === 'escape') {
      this.label = undefined;
    } else {
      open.input.handleInput(data);
    }
  }

  // The header's key hints, from the registry, so a rebound key shows.
  private help(): TreeHelpItem[] {
    const keys = this.options.keys;
    const caps = (...actions: KeyAction[]): string =>
      joinKeys(
        actions.map((action) => treeCap(keys.label(action))).filter(Boolean),
      );
    return [
      { keys: caps('tree.up', 'tree.down'), label: 'move' },
      { keys: caps('tree.pageUp', 'tree.pageDown'), label: 'page' },
      { keys: caps('tree.foldOrUp', 'tree.unfoldOrDown'), label: 'branch' },
      { keys: caps('tree.copy'), label: 'copy' },
      { keys: caps('tree.label'), label: 'label' },
      { keys: caps('tree.labelTime'), label: 'label time' },
      {
        keys: caps(...FILTER_KEYS.map(([action]) => action)),
        label: 'filters',
        labelFirst: true,
      },
      {
        keys: caps('tree.filter.next', 'tree.filter.previous'),
        label: 'cycle',
        labelFirst: true,
      },
    ].filter((item) => item.keys !== '');
  }

  render(ui: UiTheme, width: number): string[] {
    const lines = renderTreeHeader(ui, width, this.help(), this.state.search);
    lines.push('');
    if (this.label === undefined) {
      lines.push(...renderTreeRows(ui, this.state, width));
    } else {
      const field = this.label.input.render(Math.max(1, width - 2))[0] ?? '';
      lines.push(
        truncateToWidth(`  ${ui.fg('fg2')('Label (empty to remove):')}`, width),
        truncateToWidth(`  ${field}`, width),
        truncateToWidth(
          `  ${ui.fg('fg0')('⏎')} ${ui.fg('fg2')('save')}  ${ui.fg('fg0')('esc')} ${ui.fg('fg2')('back to the tree')}`,
          width,
        ),
      );
    }
    lines.push('', renderTreeRule(ui, width));
    return lines;
  }
}
