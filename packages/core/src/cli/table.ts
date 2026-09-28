// Tabular output for CLI reports. Two renderings of one input:
//
// - fancy (cli-table3 box drawing, accent headers) on an interactive,
//   coloured terminal;
// - plain, space-aligned columns everywhere else (pipes, CI logs,
//   NO_COLOR) — stable, grep/awk-friendly, and free of box characters.
//
// Returns the table as a string with no trailing newline; the caller
// prints it through its `out` channel. Never used for `--json` output.

import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import type CliTable from 'cli-table3';
import type { CliTheme } from './theme.js';

export interface TableColumn {
  readonly header: string;
  readonly align?: 'left' | 'right';
}

export interface TableOptions {
  // Box-drawn rendering; false (the default) is the plain aligned text.
  readonly fancy?: boolean;
  // Colours the fancy headers; ignored by the plain rendering.
  readonly theme?: CliTheme;
}

const GAP = '  ';

// Zero-width: combining marks, format/ignorable code points (ZWJ,
// variation selectors) and C0/C1 controls.
const ZERO_WIDTH = /^[\p{Mark}\p{Default_Ignorable_Code_Point}\p{Cc}]$/u;
// Emoji shown as pictures take two cells.
const WIDE_EMOJI = /^\p{Emoji_Presentation}$/u;

// East Asian Wide/Fullwidth blocks (the ranges `is-fullwidth-code-point`,
// cli-table3's own measure, uses): two terminal cells each.
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

// Terminal display width (cells), not UTF-16 length: ANSI escapes and
// zero-width code points count 0, wide CJK and emoji count 2.
function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    if (ZERO_WIDTH.test(char)) continue;
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) || WIDE_EMOJI.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const fill = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return align === 'right' ? `${fill}${text}` : `${text}${fill}`;
}

function plainTable(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
): string {
  const widths = columns.map((column, index) =>
    Math.max(
      visibleWidth(column.header),
      ...rows.map((row) => visibleWidth(row[index] ?? '')),
    ),
  );
  const line = (cells: readonly string[]): string =>
    columns
      .map((column, index) => {
        const cell = cells[index] ?? '';
        // The last left-aligned column is not padded: no trailing spaces.
        const last = index === columns.length - 1;
        const align = column.align ?? 'left';
        return last && align === 'left'
          ? cell
          : pad(cell, widths[index] ?? 0, align);
      })
      .join(GAP)
      .trimEnd();
  return [line(columns.map((column) => column.header)), ...rows.map(line)].join(
    '\n',
  );
}

export function renderTable(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
  options: TableOptions = {},
): string {
  if (options.fancy !== true) return plainTable(rows, columns);
  // cli-table3 loads only for a box-drawn table (an interactive, coloured
  // terminal): pipes, CI and `--json` never pay its import.
  const Table = createRequire(import.meta.url)('cli-table3') as typeof CliTable;
  const theme = options.theme;
  const table = new Table({
    head: columns.map((column) =>
      theme === undefined ? column.header : theme.accent(column.header),
    ),
    colAligns: columns.map((column) => column.align ?? 'left'),
    // Colour comes from the theme, never cli-table3's own defaults.
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    table.push(columns.map((_, index) => row[index] ?? ''));
  }
  return table.toString();
}
