// Tabular output for CLI reports. Two renderings of one input:
//
// - fancy (cli-table3 box drawing, accent headers) on an interactive,
//   coloured terminal;
// - plain, space-aligned columns everywhere else (pipes, CI logs,
//   NO_COLOR) — stable, grep/awk-friendly, and free of box characters.
//
// Returns the table as a string with no trailing newline; the caller
// prints it through its `out` channel. Never used for `--json` output.

import { stripVTControlCharacters } from 'node:util';
import Table from 'cli-table3';
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

function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
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
