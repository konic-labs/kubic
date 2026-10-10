// The confirmation dialog: a closed heavy box in the warning colour, centred
// over the screen. The question is its title, the consequences wrap inside
// it, and the two answers sit at the bottom as key caps. Every line is the
// box's full width and the body is painted on its own surface, so nothing
// behind the dialog shows through. Presentation only — the app owns the
// keys, the loop owns what the verdict does.

import type { UiTheme } from '@kubic/core/ui/style';
import { frameInnerWidth, frameLines } from './ui/frame.js';
import { wrapStyled } from './ui/line.js';
import { badge } from './ui/marks.js';

export interface ConfirmViewOptions {
  readonly title: string;
  readonly body: readonly string[];
  /** The accept key as a cap (`^S`). */
  readonly confirmKey: string;
  readonly confirmAction: string;
  readonly cancelAction: string;
}

/** The dialog's width on a terminal wide enough for it. */
export const CONFIRM_WIDTH = 68;

export function renderConfirm(
  ui: UiTheme,
  options: ConfirmViewOptions,
  width: number,
): string[] {
  const w = Math.max(12, Math.floor(width));
  const inner = frameInnerWidth(w);
  const prose = options.body.flatMap((line) =>
    wrapStyled(ui.fg('fg1')(line), Math.max(1, inner - 2)).map(
      (row) => ` ${row}`,
    ),
  );
  const answers = ` ${badge(ui, options.confirmKey, 'key')} ${ui.style({ fg: 'warn', bold: true })(options.confirmAction)}    ${badge(ui, 'esc', 'key')} ${ui.fg('fg1')(options.cancelAction)}`;
  return frameLines(ui, ['', ...prose, '', answers, ''], w, {
    weight: 'heavy',
    color: 'warn',
    title: ui.style({ fg: 'warn', bold: true })(options.title),
    bodyBg: 'bg1',
  });
}
