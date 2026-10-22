// The session tree drawn the way pi draws its tree: a header (the title, the
// keys, the search), then one row per entry: the cursor's gutter, the tree's
// indentation with its connectors and fold marks, a bullet on the path to the
// current entry, the entry's label and the entry itself, then the position.
// A deep selection pans the rows sideways so its text stays in view, while
// the cursor's gutter never moves.
import type { UiTheme } from '@kubic/core/ui/style';
import type {
  SessionTreeState,
  TreeEntryLike,
  TreeFilter,
} from './session-tree.js';
import type { TreeRow } from './session-tree-layout.js';
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';
import { fillLine } from './ui/surface.js';

/** One key-hint item of the header: `↑/↓ move`, `filters ^D/^T`. */
export interface TreeHelpItem {
  readonly keys: string;
  readonly label: string;
  /** Put the label before the keys (`filters ^D/^T/^U`). */
  readonly labelFirst?: boolean;
}

const TITLE = 'Session tree';
// The cursor's gutter: `› ` on the selected row, kept while the rows pan.
const GUTTER = 2;
// Panning keeps at least this much of the selected entry's text in view,
// with a little of the tree before it.
const MIN_TEXT = 4;
const MAX_TEXT = 20;
const MIN_CONTEXT = 2;
const MAX_CONTEXT = 12;
// An entry's text is cut here before it is drawn; a row never shows more.
const MAX_TEXT_CHARS = 200;

const FILTER_TAG: Record<TreeFilter, string> = {
  default: '',
  'no-tools': ' [no-tools]',
  'user-only': ' [user]',
  'labeled-only': ' [labeled]',
  all: ' [all]',
};

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, MAX_TEXT_CHARS).join('');
}

/** `14:05` today, `3/7 14:05` this year, `24/3/7 14:05` before. */
/** @internal */
export function formatLabelTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const two = (value: number): string => String(value).padStart(2, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  if (date.getFullYear() === now.getFullYear()) return `${day} ${time}`;
  return `${String(date.getFullYear()).slice(-2)}/${day} ${time}`;
}

// The entry itself: its role in its colour, then its text.
function entryText(ui: UiTheme, entry: TreeEntryLike): string {
  const text = oneLine(entry.text);
  switch (entry.kind) {
    case 'user':
      return `${ui.fg('accent')('user: ')}${text}`;
    case 'assistant': {
      const role = ui.fg('ok')('assistant: ');
      if (entry.state === 'aborted')
        return `${role}${ui.fg('fg2')('(aborted)')}`;
      if (entry.state === 'error') return `${role}${ui.fg('err')(text)}`;
      if (entry.state === 'empty')
        return `${role}${ui.fg('fg2')('(no content)')}`;
      return `${role}${text}`;
    }
    case 'tool':
      return ui.fg('fg2')(`[${text}]`);
    case 'compaction':
      return ui.fg('info')(
        text === '' ? '[compaction]' : `[compaction: ${text}]`,
      );
    case 'reset':
      return `${ui.fg('warn')('[reset]: ')}${text}`;
    case 'system':
      return ui.fg('fg3')('[system]');
    default:
      return ui.fg('fg3')(`[${text}]`);
  }
}

// The tree's indentation for a row: three cells per level, with a gutter
// (│) where an open branch passes and the connector (├─ └─) where the row
// joins its branch point; the connector's second cell is the fold mark.
function indentation(
  state: SessionTreeState,
  row: TreeRow,
  displayIndent: number,
): string {
  const connector = row.showConnector && !row.virtualRootChild;
  const connectorAt = connector ? displayIndent - 1 : -1;
  const chars: string[] = [];
  for (let cell = 0; cell < displayIndent * 3; cell += 1) {
    const level = Math.floor(cell / 3);
    const column = cell % 3;
    const gutter = row.gutters.find((g) => g.position === level);
    if (gutter !== undefined) {
      chars.push(column === 0 && gutter.show ? '│' : ' ');
    } else if (level === connectorAt) {
      if (column === 0) chars.push(row.isLast ? '└' : '├');
      else if (column === 1) {
        chars.push(
          state.isFolded(row.id) ? '⊞' : state.isFoldable(row.id) ? '⊟' : '─',
        );
      } else chars.push(' ');
    } else chars.push(' ');
  }
  return chars.join('');
}

interface DrawnRow {
  readonly gutter: string;
  readonly body: string;
  // Where the entry's own text starts in the body (after the tree).
  readonly anchor: number;
  readonly selected: boolean;
}

function drawRow(
  ui: UiTheme,
  state: SessionTreeState,
  row: TreeRow,
  selected: boolean,
): DrawnRow {
  const entry = state.entry(row.id) as TreeEntryLike;
  const displayIndent = state.multipleRoots
    ? Math.max(0, row.indent - 1)
    : row.indent;
  const tree = ui.fg('fg3')(indentation(state, row, displayIndent));
  const foldInConnector = row.showConnector && !row.virtualRootChild;
  const fold =
    state.isFolded(row.id) && !foldInConnector ? ui.fg('accent')('⊞ ') : '';
  const path = state.isOnPath(row.id) ? ui.fg('accent')('• ') : '';
  const label =
    entry.label === undefined ? '' : ui.fg('warn')(`[${entry.label}] `);
  const time =
    state.labelTimes && entry.label !== undefined && entry.labelAt !== undefined
      ? ui.fg('fg2')(`${formatLabelTime(entry.labelAt)} `)
      : '';
  const text = entryText(ui, entry);
  const lead = `${tree}${fold}${path}`;
  return {
    gutter: selected ? ui.fg('accent')('› ') : '  ',
    body: `${lead}${label}${time}${selected ? ui.style({ bold: true })(text) : text}`,
    anchor: visibleWidth(lead),
    selected,
  };
}

// Pan the bodies left when the selected row's text starts too far right to
// read; the gutter stays.
function pan(ui: UiTheme, rows: readonly DrawnRow[], width: number): string[] {
  const viewport = Math.max(0, width - GUTTER);
  const widest = rows.reduce(
    (max, row) => Math.max(max, visibleWidth(row.body)),
    0,
  );
  const most = Math.max(0, widest - viewport);
  const selected = rows.find((row) => row.selected);
  let shift = 0;
  if (selected !== undefined && most > 0) {
    const keep = Math.min(
      MAX_TEXT,
      Math.max(MIN_TEXT, Math.floor(viewport / 3)),
    );
    if (selected.anchor > viewport - keep) {
      const context = Math.min(
        MAX_CONTEXT,
        Math.max(MIN_CONTEXT, Math.floor(viewport / 4)),
      );
      shift = Math.min(most, selected.anchor - context);
    }
  }
  return rows.map((row) => {
    const body =
      shift > 0 ? sliceByColumn(row.body, shift, viewport, true) : row.body;
    const line = truncateToWidth(`${row.gutter}${body}`, width, '');
    return row.selected ? fillLine(ui, line, width, 'bg2') : line;
  });
}

/** The rows in view and the position line under them. */
export function renderTreeRows(
  ui: UiTheme,
  state: SessionTreeState,
  width: number,
): string[] {
  const tags = `${FILTER_TAG[state.filter]}${state.labelTimes ? ' [+label time]' : ''}`;
  const rows = state.rows;
  if (rows.length === 0) {
    return [
      truncateToWidth(ui.fg('fg2')('  No entries found'), width),
      truncateToWidth(ui.fg('fg2')(`  (0/0)${tags}`), width),
    ];
  }
  const index = state.selectedIndex;
  const start = Math.max(
    0,
    Math.min(
      index - Math.floor(state.maxVisible / 2),
      rows.length - state.maxVisible,
    ),
  );
  const end = Math.min(start + state.maxVisible, rows.length);
  const drawn = rows
    .slice(start, end)
    .map((row, offset) => drawRow(ui, state, row, start + offset === index));
  return [
    ...pan(ui, drawn, width),
    truncateToWidth(
      ui.fg('fg2')(`  (${index + 1}/${rows.length})${tags}`),
      width,
    ),
  ];
}

/** A full-width rule in the tree's border colour. */
export function renderTreeRule(ui: UiTheme, width: number): string {
  return ui.fg('info')('─'.repeat(Math.max(0, width)));
}

// The key hints, joined with ` · ` and wrapped whole at the width.
function helpLines(
  ui: UiTheme,
  help: readonly TreeHelpItem[],
  width: number,
): string[] {
  const items = help.map((item) =>
    item.keys === ''
      ? item.label
      : item.labelFirst === true
        ? `${item.label} ${item.keys}`
        : `${item.keys} ${item.label}`,
  );
  const indent = '  ';
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    const candidate = line === '' ? `${indent}${item}` : `${line} · ${item}`;
    if (line === '' || visibleWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    lines.push(...wrapTextWithAnsi(line, Math.max(1, width)));
    line = `${indent}${item}`;
  }
  if (line !== '') lines.push(...wrapTextWithAnsi(line, Math.max(1, width)));
  return lines.map((text) => ui.fg('fg2')(text));
}

/** The header: a blank line, a rule, the title, the keys, the search, a rule. */
export function renderTreeHeader(
  ui: UiTheme,
  width: number,
  help: readonly TreeHelpItem[],
  search: string,
): string[] {
  const prompt = ui.fg('fg2')('Type to search:');
  return [
    '',
    renderTreeRule(ui, width),
    truncateToWidth(`   ${ui.style({ fg: 'fg0', bold: true })(TITLE)}`, width),
    ...helpLines(ui, help, width),
    truncateToWidth(
      `  ${prompt}${search === '' ? '' : ` ${ui.fg('accent')(search)}`}`,
      width,
    ),
    renderTreeRule(ui, width),
  ];
}
