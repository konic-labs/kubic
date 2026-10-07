// The inline diff block. Input is
// the display diff a file change records (`+<n> text`, `-<n> text`,
// ` <n> text`, ` <pad> ...` for a gap); output is card body rows: context
// rows with an fg3 line number, removed rows on the delBg surface with `−`,
// added rows on addBg with `+`, gaps as an fg3 `⋮`. Each removed line that
// pairs with an added one gets a word-level highlight: the tokens outside
// their longest common subsequence take the stronger *WordBg surface (and
// bold, so the change still reads where the palette has no backgrounds).

import type { UiTheme } from '../../../core/src/ui/style.js';
import { fitLine } from './line.js';
import { fillLine } from './surface.js';

export type DiffRowKind = 'context' | 'add' | 'del' | 'gap';

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** The line number as written (`10`), empty for a gap. */
  readonly number: string;
  readonly text: string;
}

const ROW = /^([-+ ])( *\d+) (.*)$/u;
const GAP = /^ +\.\.\.$/u;

export function parseDisplayDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (GAP.test(line)) {
      rows.push({ kind: 'gap', number: '', text: '' });
      continue;
    }
    const hit = ROW.exec(line);
    if (hit === null) continue;
    const sign = hit[1];
    rows.push({
      kind: sign === '+' ? 'add' : sign === '-' ? 'del' : 'context',
      number: (hit[2] ?? '').trim(),
      text: hit[3] ?? '',
    });
  }
  return rows;
}

// Words, runs of spaces, and runs of punctuation (so `+=` against `=` is
// one changed operator, not a shared `=` and a stray `+`).
const TOKEN = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]+/gu;

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Lines past this length are not word-diffed. */
export const WORD_DIFF_MAX_CHARS = 400;

/**
 * Which tokens of each side changed, or undefined when the lines are too
 * long or share less than half their content (a rewrite, not an edit).
 */
export function wordDiff(
  before: string,
  after: string,
):
  | {
      readonly before: boolean[];
      readonly after: boolean[];
      readonly a: string[];
      readonly b: string[];
    }
  | undefined {
  if (
    before.length > WORD_DIFF_MAX_CHARS ||
    after.length > WORD_DIFF_MAX_CHARS
  ) {
    return undefined;
  }
  const a = tokens(before);
  const b = tokens(after);
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const changedA = a.map(() => true);
  const changedB = b.map(() => true);
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      changedA[i] = false;
      changedB[j] = false;
      common += (a[i] as string).length;
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const longer = Math.max(before.length, after.length);
  if (longer === 0 || common / longer < 0.5) return undefined;
  return { before: changedA, after: changedB, a, b };
}

export interface DiffBlockOptions {
  /** Width of the line-number column (defaults to the widest number). */
  readonly numberWidth?: number;
}

/**
 * Render the rows at `width` cells. Context rows are fitted; added and
 * removed rows are painted edge to edge on their surface.
 */
export function renderDiffRows(
  ui: UiTheme,
  rows: readonly DiffRow[],
  width: number,
  options: DiffBlockOptions = {},
): string[] {
  const digits =
    options.numberWidth ?? Math.max(1, ...rows.map((row) => row.number.length));
  // Pair each removed run with the added run right after it, line by line.
  const highlights = new Map<number, boolean[]>();
  const tokenized = new Map<number, string[]>();
  for (let index = 0; index < rows.length; ) {
    if (rows[index]?.kind !== 'del') {
      index += 1;
      continue;
    }
    let delEnd = index;
    while (rows[delEnd]?.kind === 'del') delEnd += 1;
    let addEnd = delEnd;
    while (rows[addEnd]?.kind === 'add') addEnd += 1;
    const pairs = Math.min(delEnd - index, addEnd - delEnd);
    for (let k = 0; k < pairs; k += 1) {
      const del = rows[index + k] as DiffRow;
      const add = rows[delEnd + k] as DiffRow;
      const diff = wordDiff(del.text, add.text);
      if (diff === undefined) continue;
      highlights.set(index + k, diff.before);
      tokenized.set(index + k, diff.a);
      highlights.set(delEnd + k, diff.after);
      tokenized.set(delEnd + k, diff.b);
    }
    index = addEnd;
  }
  return rows.map((row, index) => {
    const number = row.number.padStart(digits);
    if (row.kind === 'gap') {
      return fitLine(
        ui.fg('fg3')(`${' '.repeat(Math.max(0, digits - 1))}⋮`),
        width,
      );
    }
    if (row.kind === 'context') {
      return fitLine(
        `${ui.fg('fg3')(number)}   ${ui.fg('fg1')(row.text)}`,
        width,
      );
    }
    const role = row.kind === 'add' ? 'add' : 'del';
    const word = row.kind === 'add' ? 'addWordBg' : 'delWordBg';
    const surface = row.kind === 'add' ? 'addBg' : 'delBg';
    const sign = row.kind === 'add' ? '+' : '−';
    const marks = highlights.get(index);
    const parts = tokenized.get(index);
    let text: string;
    if (marks === undefined || parts === undefined) {
      text = ui.fg(role)(row.text);
    } else {
      text = parts
        .map((token, at) =>
          marks[at] === true && token.trim() !== ''
            ? ui.style({ fg: role, bg: word, bold: true })(token)
            : ui.fg(role)(token),
        )
        .join('');
    }
    return fillLine(
      ui,
      `${ui.fg(role)(`${number} ${sign}`)} ${text}`,
      width,
      surface,
    );
  });
}
