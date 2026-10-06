// Full-width surfaces (EPIC N, issue #452): a line painted on a background
// token role from edge to edge, keeping that background through any nested
// style (inline code, a word-level diff highlight) via the style engine's
// background reassertion. Without a background (depth none, the terminal
// palette, a 16-colour surface) the line is only fitted, never padded, so
// plain snapshots carry no trailing spaces.

import {
  reassertBackground,
  type UiTheme,
} from '../../../core/src/ui/style.js';
import type { TokenRole } from '../../../core/src/ui/tokens.js';
import { exactWidth, fitLine } from './line.js';

export function fillLine(
  ui: UiTheme,
  text: string,
  width: number,
  bg: TokenRole,
): string {
  const open = ui.open({ bg });
  if (open === '') return fitLine(text, width);
  return `${open}${reassertBackground(exactWidth(text, width), open)}${ui.close({ bg })}`;
}

export function surfaceLines(
  ui: UiTheme,
  lines: readonly string[],
  width: number,
  bg: TokenRole,
): string[] {
  return lines.map((line) => fillLine(ui, line, width, bg));
}
