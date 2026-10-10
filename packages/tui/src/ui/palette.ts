// The command palette (^P). One fuzzy search over four groups — COMMANDS,
// MODELS, SESSIONS, FILES, in that order — each hidden when nothing in it
// matches and, while searching, capped at PALETTE_GROUP_ROWS until `tab`
// focuses it. Pi's fuzzyMatch ranks (the row's text first, a command's
// summary at a lower weight) and fuzzyPositions marks the matched letters.
// An empty query lists every command, the recent ones first, and the current
// model; a list taller than the overlay scrolls with the selection. Pure:
// state in, state or lines out.

import type { UiTheme } from '@kubic/core/ui/style';
import { fuzzyMatch, visibleWidth } from '../tui-boundary.js';
import { exactWidth, leftRight, padTo } from './line.js';
import { sectionLabel } from './marks.js';
import { fuzzyPositions, highlightPositions } from './match.js';
import { fillLine } from './surface.js';

type PaletteGroupId = 'commands' | 'models' | 'sessions' | 'files';

const PALETTE_GROUP_ORDER: readonly PaletteGroupId[] = [
  'commands',
  'models',
  'sessions',
  'files',
];

/** Rows a group shows until `tab` focuses it. */
export const PALETTE_GROUP_ROWS = 6;

/** Project files the palette indexes at most. */
export const PALETTE_FILES_MAX = 2000;

// A match in a command's summary ranks below a match in a name.
const DETAIL_PENALTY = 40;

// The widest a command name column grows before the summary.
const NAME_COLUMN = 18;

/** The MODELS header's right side, aligned over `paletteModelMeta`. */
const MODEL_COLUMNS = 'context  thinking';

export interface PaletteItem {
  readonly group: PaletteGroupId;
  /** What the row acts on: `/model`, `provider/id`, a session id, a path. */
  readonly value: string;
  /** What the query matches first, and what the row shows. */
  readonly text: string;
  /** Matched at a lower weight, shown after the text (a command summary). */
  readonly detail?: string;
  /** Right-aligned: a key, `2m ago`, `@ insert`, the model columns. */
  readonly meta?: string;
  /** The live model: `●` and `current`. */
  readonly current?: boolean;
  /** Shown for an empty query (the recent commands). */
  readonly recent?: boolean;
}

/** @internal */
export interface PaletteMatch {
  readonly item: PaletteItem;
  /** Matched indices in `item.text`, and in `item.detail`. */
  readonly positions: readonly number[];
  readonly detailPositions: readonly number[];
  /** Pi's score (lower is better); 0 while browsing. */
  readonly score: number;
}

/** @internal */
export interface PaletteGroupView {
  readonly group: PaletteGroupId;
  readonly rows: readonly PaletteMatch[];
  /** Every match in the group, before the cap. */
  readonly total: number;
}

export interface PaletteState {
  readonly query: string;
  readonly items: readonly PaletteItem[];
  /** Index into `paletteRows(state)`. */
  readonly selected: number;
  /** The `tab`-focused group, shown uncapped. */
  readonly focus: PaletteGroupId | undefined;
  /** `→` opened the one-line details footer. */
  readonly details: boolean;
}

export function createPalette(items: readonly PaletteItem[]): PaletteState {
  return { query: '', items, selected: 0, focus: undefined, details: false };
}

function terms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter((term) => term !== '');
}

function sorted(positions: Set<number>): number[] {
  return [...positions].sort((a, b) => a - b);
}

// Every term must match the text, or else appear in the detail (at the
// penalty): scattered letters across a sentence are noise, not a match.
function rank(
  item: PaletteItem,
  words: readonly string[],
): PaletteMatch | undefined {
  let score = 0;
  const positions = new Set<number>();
  const detailPositions = new Set<number>();
  for (const word of words) {
    const primary = fuzzyMatch(word, item.text);
    if (primary.matches) {
      score += primary.score;
      for (const at of fuzzyPositions(word, item.text) ?? []) positions.add(at);
      continue;
    }
    const detail = item.detail;
    const secondary =
      detail === undefined || !detail.toLowerCase().includes(word.toLowerCase())
        ? undefined
        : fuzzyMatch(word, detail);
    if (detail !== undefined && secondary?.matches === true) {
      score += secondary.score + DETAIL_PENALTY;
      for (const at of fuzzyPositions(word, detail) ?? []) {
        detailPositions.add(at);
      }
      continue;
    }
    return undefined;
  }
  return {
    item,
    positions: sorted(positions),
    detailPositions: sorted(detailPositions),
    score,
  };
}

function plain(item: PaletteItem): PaletteMatch {
  return { item, positions: [], detailPositions: [], score: 0 };
}

// A group's matches, best first, before the cap.
function groupMatches(
  state: PaletteState,
  group: PaletteGroupId,
): PaletteMatch[] {
  const items = state.items.filter((item) => item.group === group);
  const words = terms(state.query);
  if (words.length === 0) {
    // Browsing: a focused group lists everything; the commands list every
    // command, the recent ones first, so the arrows reach all of them; the
    // models show the one in use.
    if (state.focus === group) return items.map(plain);
    if (group === 'commands') {
      const recent = items.filter((item) => item.recent === true);
      const rest = items.filter((item) => item.recent !== true);
      return [...recent, ...rest].map(plain);
    }
    if (group === 'models') {
      return items.filter((item) => item.current === true).map(plain);
    }
    return [];
  }
  const ranked: PaletteMatch[] = [];
  for (const item of items) {
    const hit = rank(item, words);
    if (hit !== undefined) ranked.push(hit);
  }
  return ranked.sort(
    (a, b) =>
      a.score - b.score ||
      a.item.text.length - b.item.text.length ||
      a.item.text.localeCompare(b.item.text),
  );
}

/** @internal */
export function paletteGroups(state: PaletteState): PaletteGroupView[] {
  const views: PaletteGroupView[] = [];
  for (const group of PALETTE_GROUP_ORDER) {
    const matches = groupMatches(state, group);
    if (matches.length === 0) continue;
    // Browsing never caps the commands: the list scrolls instead.
    const browsingCommands =
      group === 'commands' && terms(state.query).length === 0;
    views.push({
      group,
      rows:
        state.focus === group || browsingCommands
          ? matches
          : matches.slice(0, PALETTE_GROUP_ROWS),
      total: matches.length,
    });
  }
  return views;
}

/** The rows on screen, in order (what `selected` indexes). */
/** @internal */
export function paletteRows(state: PaletteState): PaletteMatch[] {
  return paletteGroups(state).flatMap((view) => view.rows);
}

/** Every match, capped groups included (the `N results` count). */
export function paletteResultCount(state: PaletteState): number {
  return paletteGroups(state).reduce((sum, view) => sum + view.total, 0);
}

export function selectedPaletteItem(
  state: PaletteState,
): PaletteItem | undefined {
  return paletteRows(state)[state.selected]?.item;
}

function firstRowOf(
  state: PaletteState,
  group: PaletteGroupId | undefined,
): number {
  if (group === undefined) return 0;
  let at = 0;
  for (const view of paletteGroups(state)) {
    if (view.group === group) return at;
    at += view.rows.length;
  }
  return 0;
}

// The best match of any group (the groups keep their order on screen).
function bestRow(state: PaletteState): number {
  let best = 0;
  paletteRows(state).forEach((row, at, rows) => {
    if (row.score < (rows[best]?.score ?? 0)) best = at;
  });
  return best;
}

export function setPaletteQuery(
  state: PaletteState,
  query: string,
): PaletteState {
  if (query === state.query) return state;
  const next = { ...state, query };
  return {
    ...next,
    selected:
      next.focus === undefined ? bestRow(next) : firstRowOf(next, next.focus),
  };
}

/** New rows (sessions and files arrive later): the selection stays put. */
export function setPaletteItems(
  state: PaletteState,
  items: readonly PaletteItem[],
): PaletteState {
  const chosen = selectedPaletteItem(state);
  const next = { ...state, items };
  if (chosen === undefined) return { ...next, selected: 0 };
  const at = paletteRows(next).findIndex(
    (row) => row.item.group === chosen.group && row.item.value === chosen.value,
  );
  return { ...next, selected: at === -1 ? 0 : at };
}

/** `↑`/`↓`: one row, wrapping across the groups. */
export function movePalette(state: PaletteState, delta: number): PaletteState {
  const count = paletteRows(state).length;
  if (count === 0) return state;
  return {
    ...state,
    selected: (((state.selected + delta) % count) + count) % count,
  };
}

/** `tab`/`shift+tab`: focus the next or previous group with rows. */
export function cyclePaletteGroup(
  state: PaletteState,
  direction: 1 | -1,
): PaletteState {
  const available = PALETTE_GROUP_ORDER.filter(
    (group) => groupMatches({ ...state, focus: group }, group).length > 0,
  );
  if (available.length === 0) return state;
  const current = selectedPaletteItem(state)?.group ?? state.focus;
  const at = current === undefined ? -1 : available.indexOf(current);
  const index =
    at === -1
      ? direction === 1
        ? 0
        : available.length - 1
      : (at + direction + available.length) % available.length;
  const focus = available[index];
  const next = { ...state, focus };
  return { ...next, selected: firstRowOf(next, focus) };
}

/** `→`: the selected row's full text in a one-line footer. */
export function togglePaletteDetails(state: PaletteState): PaletteState {
  return { ...state, details: !state.details };
}

/** `200k`, `1M`: a context window in the MODELS column. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** A model row's right side, aligned under MODEL_COLUMNS. */
export function paletteModelMeta(
  contextWindow?: number,
  reasoning?: boolean,
): string {
  const context =
    contextWindow === undefined ? '' : formatContextWindow(contextWindow);
  const thinking = reasoning === undefined ? '' : reasoning ? 'yes' : 'no';
  return `${context.padStart(7)}  ${thinking.padEnd(8)}`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface PaletteRenderOptions {
  /** The query field as Pi's Input draws it (its cursor included). */
  readonly input: string;
  /** Rows the overlay may take; the list scrolls to keep the selection. */
  readonly maxRows: number;
  /** The palette key's cap for the title (`^P`). */
  readonly keyLabel: string;
}

function renderRow(
  ui: UiTheme,
  match: PaletteMatch,
  group: PaletteGroupId,
  selected: boolean,
  inner: number,
  nameWidth: number,
): string {
  const { item } = match;
  const edge = selected ? ui.fg('accent')('▌') : ' ';
  const hit = selected
    ? ui.style({ fg: 'accent', bold: true })
    : ui.fg('accent');
  let text = highlightPositions(
    item.text,
    match.positions,
    hit,
    ui.fg(selected ? 'fg0' : 'fg1'),
  );
  if (group === 'commands') text = padTo(text, nameWidth);
  const mark =
    group === 'commands'
      ? ''
      : item.current === true
        ? `${ui.fg('ok')('●')} `
        : '  ';
  const current = item.current === true ? ui.fg('fg2')('  current') : '';
  const detail =
    item.detail === undefined
      ? ''
      : `${group === 'commands' ? '' : '  '}${highlightPositions(
          item.detail,
          match.detailPositions,
          hit,
          ui.fg(selected ? 'fg1' : 'fg2'),
        )}`;
  const meta =
    item.meta === undefined
      ? ''
      : ui.fg(group === 'models' ? 'fg1' : 'fg2')(`${item.meta} `);
  const content = leftRight(
    `${edge} ${mark}${text}${current}${detail}`,
    meta,
    inner,
  );
  return selected && ui.open({ bg: 'bg3' }) !== ''
    ? fillLine(ui, content, inner, 'bg3')
    : content;
}

// The body lines in view: all of them when they fit, else a window that
// keeps the selected row on screen.
function windowAround<T extends { readonly row?: number }>(
  lines: readonly T[],
  room: number,
  selected: number,
): readonly T[] {
  if (lines.length <= room) return lines;
  const at = Math.max(
    0,
    lines.findIndex((line) => line.row === selected),
  );
  const start = Math.min(
    Math.max(0, at - Math.floor(room / 2)),
    lines.length - room,
  );
  return lines.slice(start, start + room);
}

const PALETTE_TITLE = 'Command palette';

export function renderPalette(
  ui: UiTheme,
  state: PaletteState,
  width: number,
  options: PaletteRenderOptions,
): string[] {
  const w = Math.max(10, Math.floor(width));
  const inner = w - 2;
  const border = ui.fg('fg1');
  const framed = (content: string): string =>
    `${border('│')}${content}${border('│')}`;
  const title = ui.style({ fg: 'accent', bold: true })(PALETTE_TITLE);
  const keyLabel = ui.fg('fg2')(options.keyLabel);
  const dashes = Math.max(
    0,
    w - 8 - visibleWidth(PALETTE_TITLE) - visibleWidth(options.keyLabel),
  );
  const top = `${border('┌─ ')}${title}${border(` ${'─'.repeat(dashes)} `)}${keyLabel}${border(' ─┐')}`;
  const count = paletteResultCount(state);
  const query = leftRight(
    `${ui.style({ fg: 'accent', bold: true })(' › ')}${options.input}`,
    ui.fg('fg2')(`${count} result${count === 1 ? '' : 's'} `),
    inner,
  );
  const separator = `${border('├')}${ui.fg('fg3')('─'.repeat(inner))}${border('┤')}`;
  const bottom = border(`└${'─'.repeat(inner)}┘`);
  const body: Array<{ readonly text: string; readonly row?: number }> = [];
  const groups = paletteGroups(state);
  let index = 0;
  groups.forEach((view, at) => {
    if (at > 0) body.push({ text: exactWidth('', inner) });
    body.push({
      text: leftRight(
        ` ${sectionLabel(ui, view.group)}`,
        view.group === 'models' ? ui.fg('fg3')(`${MODEL_COLUMNS} `) : '',
        inner,
      ),
    });
    const nameWidth =
      view.group === 'commands'
        ? Math.min(
            NAME_COLUMN,
            Math.max(...view.rows.map((row) => visibleWidth(row.item.text))) +
              2,
          )
        : 0;
    for (const match of view.rows) {
      body.push({
        text: renderRow(
          ui,
          match,
          view.group,
          index === state.selected,
          inner,
          nameWidth,
        ),
        row: index,
      });
      index += 1;
    }
  });
  if (groups.length === 0) {
    body.push({
      text: exactWidth(ui.fg('fg2')('  no matches — esc to close'), inner),
    });
  }
  const footer: string[] = [];
  const chosen = selectedPaletteItem(state);
  if (state.details && chosen !== undefined) {
    const full =
      chosen.detail === undefined
        ? chosen.text
        : `${chosen.text} — ${chosen.detail}`;
    footer.push(separator, framed(exactWidth(ui.fg('fg1')(` ${full}`), inner)));
  }
  const room = Math.max(1, Math.floor(options.maxRows) - 4 - footer.length);
  return [
    top,
    framed(query),
    separator,
    ...windowAround(body, room, state.selected).map((line) =>
      framed(line.text),
    ),
    ...footer,
    bottom,
  ];
}
