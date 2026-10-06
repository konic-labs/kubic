// The key-hint row (EPIC N, issue #452; docs/ui 01-M): ` ⏎ send   ⇧⏎
// newline   / commands …        ^C ^C quit`. Keys in fg1, labels in fg2.
// When the row is too narrow, hints are dropped from the end (never split);
// the right-aligned hint is kept as long as it fits at all.

import type { UiTheme } from '../../../core/src/ui/style.js';
import { visibleWidth } from '../tui-boundary.js';
import { fitLine } from './line.js';

export type KeyHint = readonly [key: string, label: string];

const GAP = '   ';

function hintText(ui: UiTheme, [key, label]: KeyHint): string {
  return label === ''
    ? ui.fg('fg1')(key)
    : `${ui.fg('fg1')(key)} ${ui.fg('fg2')(label)}`;
}

export function renderKeyHintRow(
  ui: UiTheme,
  hints: readonly KeyHint[],
  width: number,
  right?: KeyHint,
): string {
  if (width <= 0) return '';
  const rightText = right === undefined ? '' : hintText(ui, right);
  const rightWidth = visibleWidth(rightText);
  const room = rightText === '' ? width - 1 : width - 1 - rightWidth - 2;
  const parts: string[] = [];
  let used = 0;
  for (const hint of hints) {
    const text = hintText(ui, hint);
    const cost = (parts.length === 0 ? 0 : GAP.length) + visibleWidth(text);
    if (used + cost > room) break;
    parts.push(text);
    used += cost;
  }
  const left = ` ${parts.join(GAP)}`;
  if (rightText === '' || room < 0) return fitLine(left, width);
  const spaces = width - visibleWidth(left) - rightWidth - 1;
  return `${left}${' '.repeat(Math.max(1, spaces))}${rightText} `;
}
