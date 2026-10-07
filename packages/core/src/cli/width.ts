// Terminal display width for CLI output (moved from table.ts for the output
// kit). Cells, not UTF-16 length: ANSI escapes and zero-width
// code points count 0, wide CJK and emoji count 2.

import { stripVTControlCharacters } from 'node:util';

// Zero-width: combining marks, format/ignorable code points (ZWJ,
// variation selectors) and C0/C1 controls.
const ZERO_WIDTH = /^[\p{Mark}\p{Default_Ignorable_Code_Point}\p{Cc}]$/u;
// Emoji shown as pictures take two cells.
const WIDE_EMOJI = /^\p{Emoji_Presentation}$/u;

// East Asian Wide/Fullwidth blocks (the ranges `is-fullwidth-code-point`
// uses): two terminal cells each.
function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      (code >= 0x3250 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4c6) ||
      (code >= 0xa960 && code <= 0xa97c) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6b) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b001) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

function charWidth(char: string): number {
  if (ZERO_WIDTH.test(char)) return 0;
  const code = char.codePointAt(0) ?? 0;
  return isWide(code) || WIDE_EMOJI.test(char) ? 2 : 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) width += charWidth(char);
  return width;
}

/** Pad to `width` cells (left- or right-aligned); never truncates. */
export function padVisible(
  text: string,
  width: number,
  align: 'left' | 'right' = 'left',
): string {
  const fill = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return align === 'right' ? `${fill}${text}` : `${text}${fill}`;
}

const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
  /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/;

/**
 * Cut `text` to at most `width` cells, ending with `…` when it was cut.
 * Escape sequences are kept (they take no cells) and a reset is appended
 * after a cut so a style never bleeds past the line.
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const budget = width - 1;
  let used = 0;
  let out = '';
  let styled = false;
  let index = 0;
  while (index < text.length) {
    const sequence = ESCAPE.exec(text.slice(index));
    if (sequence !== null) {
      out += sequence[0];
      styled = true;
      index += sequence[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const cells = charWidth(char);
    if (used + cells > budget) break;
    out += char;
    used += cells;
    index += char.length;
  }
  return `${out}…${styled ? '\u001b[0m' : ''}`;
}

/**
 * Plain text as rows of at most `width` cells — broken at spaces
 * where one fits, a word longer than a row cut where the row ends. Never
 * drops a character (a failure's detail must read whole).
 */
export function wrapVisible(text: string, width: number): string[] {
  const room = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    let rest = word;
    while (rest !== '') {
      const joined = row === '' ? rest : `${row} ${rest}`;
      if (visibleWidth(joined) <= room) {
        row = joined;
        rest = '';
      } else if (row !== '') {
        rows.push(row);
        row = '';
      } else {
        // A word wider than the row: cut it where the row ends.
        let cut = '';
        for (const ch of rest) {
          if (visibleWidth(cut + ch) > room) break;
          cut += ch;
        }
        rows.push(cut);
        rest = rest.slice(cut.length);
      }
    }
  }
  if (row !== '') rows.push(row);
  return rows.length === 0 ? [''] : rows;
}
