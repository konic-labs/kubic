// Line fitting for the TUI kit (EPIC N, issue #452). Cells, never string
// length: widths come from Pi's grapheme-aware helpers through the boundary.

import { truncateToWidth, visibleWidth } from '../tui-boundary.js';

export const ELLIPSIS = '…';

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
