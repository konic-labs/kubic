// Line fitting for the TUI kit. Cells, never string
// length: widths come from Pi's grapheme-aware helpers through the boundary.

import { openStyles } from '@kubic/core/ui/style';
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '../tui-boundary.js';

const ELLIPSIS = '…';

const RESET = '\u001b[0m';

/** Truncate to `width` cells with `…`; never pads. */
export function fitLine(text: string, width: number): string {
  if (width <= 0) return '';
  const fitted = truncateToWidth(text, width, ELLIPSIS);
  // Pi closes a cut with resets even for plain text; plain stays plain so
  // depth-none renders carry no escape codes.
  return text.includes('\u001b') ? fitted : fitted.replaceAll(RESET, '');
}

/** Pad to `width` cells with spaces; never truncates. */
export function padTo(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

/** Fit then pad: exactly `width` cells. */
export function exactWidth(text: string, width: number): string {
  return padTo(fitLine(text, width), width);
}

/**
 * `left … right` in exactly `width` cells. The right part keeps its room;
 * the left part is truncated first; with no room for the left at all, the
 * right part alone is fitted.
 */
export function leftRight(
  left: string,
  right: string,
  width: number,
  gap = 1,
): string {
  if (width <= 0) return '';
  const rightWidth = visibleWidth(right);
  if (right === '') return exactWidth(left, width);
  const leftRoom = width - rightWidth - gap;
  if (leftRoom < 1) return exactWidth(right, width);
  const fitted = fitLine(left, leftRoom);
  const spaces = width - visibleWidth(fitted) - rightWidth;
  return `${fitted}${' '.repeat(Math.max(gap, spaces))}${right}`;
}

// The closing code of each attribute a line may leave open.
const CLOSE: Record<string, string> = {
  intensity: '\u001b[22m',
  italic: '\u001b[23m',
  underline: '\u001b[24m',
  inverse: '\u001b[27m',
  strike: '\u001b[29m',
  fg: '\u001b[39m',
  bg: '\u001b[49m',
  hyperlink: '\u001b]8;;\u0007',
};

/**
 * The line with every style (and hyperlink) it leaves open
 * closed at its end — attribute by attribute, so a surface's own background
 * keeps painting the cells after it. A line that closes what it opens is
 * returned unchanged.
 */
export function closeOpenStyles(line: string): string {
  const open = openStyles(line);
  if (open.length === 0) return line;
  return `${line}${open.map((attr) => CLOSE[attr] ?? '').join('')}`;
}

/**
 * Pi's wrap carries a style onto the next row (re-opening it
 * there) but leaves it set at the row's end; every row here closes what it
 * leaves open, so no style bleeds past the row it was drawn on.
 */
export function wrapStyled(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width).map(closeOpenStyles);
}
