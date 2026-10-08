// The grouped picker list: what bare `/model`, `/resume`, `/theme` and
// `/thinking` open. The palette's list (ui/palette.ts) grown the parts a
// "choose one" needs: group headers with a status (`● key from …`, `○ no key`),
// groups and rows that cannot be chosen (shown greyed, never a stop), groups of
// more than PICKER_FOLD_ROWS rows folded behind `▸ expand (→)`, and a footer
// row under its own rule (the model picker's thinking row). The query filters
// with Pi's fuzzyMatch. Pure: state in, state or lines out.

import type { UiTheme } from '../../../core/src/ui/style.js';
import { fuzzyMatch, visibleWidth } from '../tui-boundary.js';
import { exactWidth, leftRight } from './line.js';
import { sectionLabel } from './marks.js';
import { fuzzyPositions, highlightPositions } from './match.js';
import { fillLine } from './surface.js';

/** A titled group with more rows than this folds until expanded. */
const PICKER_FOLD_ROWS = 8;

export interface PickerRow {
  readonly value: string;
  readonly text: string;
  /** What the query matches (default `text`): `provider/id` for a model. */
  readonly match?: string;
  /** Right-aligned: `200k ctx · thinking`, `2m ago · 4 turns`. */
  readonly right?: string;
  /** The one in use: `●` and `current`. */
  readonly current?: boolean;
  /** Shown greyed and never selected (a legacy session). */
  readonly disabled?: boolean;
  /** After the text, greyed: why it cannot be chosen. */
  readonly note?: string;
}

export interface PickerGroup {
  readonly id: string;
  /** The header (`anthropic` → ` ANTHROPIC`); untitled groups have none. */
  readonly title?: string;
  /** After the title: `● key from ANTHROPIC_API_KEY`, `○ no key`. */
  readonly status?: { readonly text: string; readonly ok: boolean };
  /** The header's right side: `set OPENAI_API_KEY`. */
  readonly right?: string;
  /** What the rows are, for a folded group's count (`183 models`). */
  readonly unit?: string;
  /** No row of it can be chosen (no key): the header alone shows. */
  readonly disabled?: boolean;
  readonly rows: readonly PickerRow[];
}

export interface PickerState {
  readonly query: string;
  readonly groups: readonly PickerGroup[];
  /** Groups opened with `→` (or by a query). */
  readonly expanded: readonly string[];
  /** Index into the stops: the rows that can be chosen and expand rows. */
  readonly selected: number;
}

type Line =
  | {
      readonly kind: 'header';
      readonly group: PickerGroup;
      readonly folded: number;
    }
  | {
      readonly kind: 'row';
      readonly row: PickerRow;
      readonly positions: readonly number[];
      readonly stop?: number;
    }
  | {
      readonly kind: 'expand';
      readonly group: PickerGroup;
      readonly stop: number;
    }
  | { readonly kind: 'gap' };

interface Stop {
  readonly group: PickerGroup;
  readonly row?: PickerRow;
}

function matches(
  query: string,
  row: PickerRow,
):
  | { readonly score: number; readonly positions: readonly number[] }
  | undefined {
  if (query === '') return { score: 0, positions: [] };
  const hit = fuzzyMatch(query, row.match ?? row.text);
  if (!hit.matches) return undefined;
  return { score: hit.score, positions: fuzzyPositions(query, row.text) ?? [] };
}

function folded(state: PickerState, group: PickerGroup): boolean {
  return (
    state.query === '' &&
    group.title !== undefined &&
    group.rows.length > PICKER_FOLD_ROWS &&
    !state.expanded.includes(group.id)
  );
}

// The display list and its stops, in order.
function layout(state: PickerState): {
  readonly lines: readonly Line[];
  readonly stops: readonly Stop[];
  readonly results: number;
} {
  const query = state.query.trim();
  const lines: Line[] = [];
  const stops: Stop[] = [];
  let results = 0;
  for (const group of state.groups) {
    const hits = group.disabled
      ? []
      : group.rows
          .map((row) => ({ row, hit: matches(query, row) }))
          .filter(
            (
              entry,
            ): entry is {
              row: PickerRow;
              hit: { score: number; positions: readonly number[] };
            } => entry.hit !== undefined,
          );
    if (query !== '') hits.sort((a, b) => a.hit.score - b.hit.score);
    const named =
      query !== '' &&
      fuzzyMatch(query, `${group.id} ${group.title ?? ''}`).matches;
    if (query !== '' && hits.length === 0 && !(group.disabled && named)) {
      continue;
    }
    // Keyless providers stack one header per row; every other
    // group is set off by a blank row.
    const previous = lines.at(-1);
    const stacked =
      group.disabled === true &&
      previous?.kind === 'header' &&
      previous.group.disabled === true;
    if (lines.length > 0 && !stacked) lines.push({ kind: 'gap' });
    const fold = folded(state, group);
    if (group.title !== undefined) {
      lines.push({
        kind: 'header',
        group,
        folded: fold ? group.rows.length : 0,
      });
    }
    if (fold) {
      lines.push({ kind: 'expand', group, stop: stops.length });
      stops.push({ group });
      continue;
    }
    for (const { row, hit } of hits) {
      if (row.disabled === true) {
        lines.push({ kind: 'row', row, positions: hit.positions });
        continue;
      }
      results += 1;
      lines.push({
        kind: 'row',
        row,
        positions: hit.positions,
        stop: stops.length,
      });
      stops.push({ group, row });
    }
  }
  return { lines, stops, results };
}

export function createPicker(groups: readonly PickerGroup[]): PickerState {
  const state: PickerState = { query: '', groups, expanded: [], selected: 0 };
  const current = layout(state).stops.findIndex(
    (stop) => stop.row?.current === true,
  );
  return { ...state, selected: Math.max(0, current) };
}

export function setPickerQuery(state: PickerState, query: string): PickerState {
  if (query === state.query) return state;
  return { ...state, query, selected: 0 };
}

/** `↑`/`↓` over the rows that can be chosen (and the expand rows), wrapping. */
export function movePicker(state: PickerState, delta: number): PickerState {
  const count = layout(state).stops.length;
  if (count === 0) return state;
  return {
    ...state,
    selected: (((state.selected + delta) % count) + count) % count,
  };
}

/** Whether the selection is a folded group's `▸ expand` row. */
export function onExpandRow(state: PickerState): boolean {
  const stop = layout(state).stops[state.selected];
  return stop !== undefined && stop.row === undefined;
}

/** `→` on an expand row: the group opens, the selection on its first row. */
export function expandPickerGroup(state: PickerState): PickerState {
  const stop = layout(state).stops[state.selected];
  if (stop === undefined || stop.row !== undefined) return state;
  const next = { ...state, expanded: [...state.expanded, stop.group.id] };
  const first = layout(next).stops.findIndex(
    (entry) => entry.group.id === stop.group.id,
  );
  return { ...next, selected: Math.max(0, first) };
}

export function selectedPickerRow(state: PickerState): PickerRow | undefined {
  return layout(state).stops[state.selected]?.row;
}

export interface PickerRenderOptions {
  readonly title: string;
  /** The query field as Pi's Input draws it (its cursor included). */
  readonly input: string;
  /** Rows the overlay may take; the list scrolls to keep the selection. */
  readonly maxRows: number;
  /** Lines under their own rule at the bottom (the thinking row). */
  readonly footer?: readonly string[];
}

function renderLine(
  ui: UiTheme,
  line: Line,
  selected: number,
  inner: number,
): string {
  if (line.kind === 'gap') return exactWidth('', inner);
  if (line.kind === 'header') {
    const { group } = line;
    const title = group.disabled
      ? ui.style({ fg: 'fg3', bold: true })((group.title ?? '').toUpperCase())
      : sectionLabel(ui, group.title ?? '');
    const status =
      group.status === undefined
        ? ''
        : `  ${ui.fg(group.status.ok ? 'ok' : 'fg3')(group.status.text)}`;
    const right =
      line.folded > 0
        ? `${line.folded} ${group.unit ?? 'more'}`
        : (group.right ?? '');
    return leftRight(
      ` ${title}${status}`,
      right === '' ? '' : ui.fg(group.disabled ? 'fg3' : 'fg2')(`${right} `),
      inner,
    );
  }
  const raised = (content: string): string =>
    ui.open({ bg: 'bg3' }) === ''
      ? content
      : fillLine(ui, content, inner, 'bg3');
  if (line.kind === 'expand') {
    const isSelected = line.stop === selected;
    const content = exactWidth(
      `${isSelected ? ui.fg('accent')('▌') : ' '}  ${ui.fg('fg2')('▸ expand (→)')}`,
      inner,
    );
    return isSelected ? raised(content) : content;
  }
  const { row } = line;
  if (row.disabled === true) {
    const note = row.note === undefined ? '' : `  ${row.note}`;
    return leftRight(
      ui.fg('fg3')(`   ${row.text}${note}`),
      row.right === undefined ? '' : ui.fg('fg3')(`${row.right} `),
      inner,
    );
  }
  const isSelected = line.stop === selected;
  const edge = isSelected ? ui.fg('accent')('▌') : ' ';
  const mark = row.current === true ? `${ui.fg('ok')('●')} ` : '  ';
  const text = highlightPositions(
    row.text,
    line.positions,
    isSelected ? ui.style({ fg: 'accent', bold: true }) : ui.fg('accent'),
    ui.fg(isSelected ? 'fg0' : 'fg1'),
  );
  const current = row.current === true ? ui.fg('fg2')('  current') : '';
  const content = leftRight(
    `${edge}${mark}${text}${current}`,
    row.right === undefined ? '' : ui.fg('fg1')(`${row.right} `),
    inner,
  );
  return isSelected ? raised(content) : content;
}

// The body lines in view: all of them when they fit, else a window that
// keeps the selected line on screen.
function windowAround(
  lines: readonly Line[],
  room: number,
  selected: number,
): readonly Line[] {
  if (lines.length <= room) return lines;
  const at = Math.max(
    0,
    lines.findIndex(
      (line) =>
        (line.kind === 'row' || line.kind === 'expand') &&
        line.stop === selected,
    ),
  );
  const start = Math.min(
    Math.max(0, at - Math.floor(room / 2)),
    lines.length - room,
  );
  return lines.slice(start, start + room);
}

export function renderPicker(
  ui: UiTheme,
  state: PickerState,
  width: number,
  options: PickerRenderOptions,
): string[] {
  const w = Math.max(10, Math.floor(width));
  const inner = w - 2;
  const border = ui.fg('fg1');
  const framed = (content: string): string =>
    `${border('│')}${content}${border('│')}`;
  const title = ui.style({ fg: 'fg0', bold: true })(options.title);
  const dashes = Math.max(0, w - 5 - visibleWidth(options.title));
  const top = `${border('┌─ ')}${title}${border(` ${'─'.repeat(dashes)}┐`)}`;
  const { lines, results } = layout(state);
  const right =
    state.query === ''
      ? 'type to filter '
      : `${results} result${results === 1 ? '' : 's'} `;
  const query = leftRight(
    `${ui.style({ fg: 'accent', bold: true })(' › ')}${options.input}`,
    ui.fg('fg2')(right),
    inner,
  );
  const separator = `${border('├')}${ui.fg('fg3')('─'.repeat(inner))}${border('┤')}`;
  const bottom = border(`└${'─'.repeat(inner)}┘`);
  const footer = options.footer ?? [];
  const body =
    lines.length === 0
      ? [exactWidth(ui.fg('fg2')('  no matches — esc to close'), inner)]
      : windowAround(
          lines,
          Math.max(
            1,
            Math.floor(options.maxRows) -
              4 -
              (footer.length === 0 ? 0 : footer.length + 1),
          ),
          state.selected,
        ).map((line) => renderLine(ui, line, state.selected, inner));
  return [
    top,
    framed(query),
    separator,
    ...body.map(framed),
    ...(footer.length === 0
      ? []
      : [separator, ...footer.map((line) => framed(exactWidth(line, inner)))]),
    bottom,
  ];
}
