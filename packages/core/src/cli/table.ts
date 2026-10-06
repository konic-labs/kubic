// Tabular output for CLI reports. Two renderings of one input:
//
// - fancy (the output kit's borderless table, issue #445): a fg2 header, a
//   faint rule, aligned columns and optional row markers, on an interactive,
//   coloured terminal;
// - plain, space-aligned columns everywhere else (pipes, CI logs,
//   NO_COLOR) — stable, grep/awk-friendly, and free of box characters.
//
// Returns the table as a string with no trailing newline; the caller
// prints it through its `out` channel. Never used for `--json` output.

import type { CliTheme } from './theme.js';
import { padVisible, visibleWidth } from './width.js';

export interface TableColumn {
  readonly header: string;
  readonly align?: 'left' | 'right';
}

export interface TableOptions {
  // The kit rendering; false (the default) is the plain aligned text.
  readonly fancy?: boolean;
  // Colours the fancy rendering; ignored by the plain rendering.
  readonly theme?: CliTheme;
  // Fancy only: one marker per row (e.g. `●` for the default row), drawn in a
  // leading two-cell column. Rows without a marker get blank cells.
  readonly markers?: readonly (string | undefined)[];
}

const GAP = '  ';

function columnWidths(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
): number[] {
  return columns.map((column, index) =>
    Math.max(
      visibleWidth(column.header),
      ...rows.map((row) => visibleWidth(row[index] ?? '')),
    ),
  );
}

function alignedLine(
  cells: readonly string[],
  columns: readonly TableColumn[],
  widths: readonly number[],
): string {
  return columns
    .map((column, index) => {
      const cell = cells[index] ?? '';
      // The last left-aligned column is not padded: no trailing spaces.
      const last = index === columns.length - 1;
      const align = column.align ?? 'left';
      return last && align === 'left'
        ? cell
        : padVisible(cell, widths[index] ?? 0, align);
    })
    .join(GAP)
    .trimEnd();
}

function plainTable(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
): string {
  const widths = columnWidths(rows, columns);
  return [
    alignedLine(
      columns.map((column) => column.header),
      columns,
      widths,
    ),
    ...rows.map((row) => alignedLine(row, columns, widths)),
  ].join('\n');
}

function kitTable(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
  options: TableOptions,
): string {
  const ui = options.theme?.ui;
  const header = ui?.style({ fg: 'fg2', bold: true }) ?? ((text) => text);
  const rule = ui?.fg('fg3') ?? ((text: string): string => text);
  const widths = columnWidths(rows, columns);
  const markers = options.markers;
  const gutter = markers === undefined ? '' : '  ';
  const headerLine = `${gutter}${alignedLine(
    columns.map((column) => header(column.header)),
    columns,
    widths,
  )}`;
  const total =
    visibleWidth(gutter) +
    widths.reduce((sum, width) => sum + width, 0) +
    GAP.length * Math.max(0, columns.length - 1);
  const body = rows.map((row, index) => {
    const marker = markers?.[index];
    const lead =
      markers === undefined
        ? ''
        : marker === undefined
          ? '  '
          : `${padVisible(marker, 1)} `;
    return `${lead}${alignedLine(row, columns, widths)}`;
  });
  return [headerLine, rule('─'.repeat(total)), ...body].join('\n');
}

export function renderTable(
  rows: readonly (readonly string[])[],
  columns: readonly TableColumn[],
  options: TableOptions = {},
): string {
  if (options.fancy !== true) return plainTable(rows, columns);
  return kitTable(rows, columns, options);
}
