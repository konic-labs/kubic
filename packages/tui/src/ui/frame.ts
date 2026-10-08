// Box-drawn frames: the editor box, overlays and the
// blocking approval card. A title and a right label sit inside the top rule;
// the body is fitted to the inner width; `sides` chooses a closed box
// (`┌─┐ │ │ └─┘`), a left edge only (the heavy `┏ ┃ ┗` card), or rules
// above and below with no verticals.

import { FRAME_HEAVY, FRAME_LIGHT } from '@kubic/core/ui/glyphs';
import type { UiTheme } from '@kubic/core/ui/style';
import type { TokenRole } from '@kubic/core/ui/tokens';
import { visibleWidth } from '../tui-boundary.js';
import { exactWidth, fitLine } from './line.js';
import { fillLine } from './surface.js';

export interface FrameOptions {
  readonly title?: string;
  readonly rightLabel?: string;
  readonly weight?: 'light' | 'heavy';
  /** The border colour role (default fg3). */
  readonly color?: TokenRole;
  readonly sides?: 'both' | 'left' | 'none';
  /** A background role for body lines (painted edge to edge inside). */
  readonly bodyBg?: TokenRole;
}

/** The inner width a frame of `width` cells leaves for the body. */
export function frameInnerWidth(
  width: number,
  sides: FrameOptions['sides'] = 'both',
): number {
  if (sides === 'both') return Math.max(0, width - 4);
  if (sides === 'left') return Math.max(0, width - 2);
  return Math.max(0, width);
}

function rule(
  ui: UiTheme,
  width: number,
  left: string,
  right: string,
  fill: string,
  color: TokenRole,
  title?: string,
  rightLabel?: string,
): string {
  const paint = ui.fg(color);
  let head = left;
  if (title !== undefined && title !== '') head += `${fill} ${title} `;
  let tail = right;
  if (rightLabel !== undefined && rightLabel !== '') {
    tail = ` ${rightLabel} ${fill}${fill}${right}`;
  }
  const missing = width - visibleWidth(head) - visibleWidth(tail);
  if (missing < 0) {
    // No room for the labels: a plain rule with its corners.
    const plain = `${left}${fill.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
    return paint(fitLine(plain, width));
  }
  // Paint only the rule characters; labels keep their own styles.
  const titlePart =
    title !== undefined && title !== ''
      ? `${paint(`${left}${fill} `)}${title}${paint(' ')}`
      : paint(left);
  const fillPart = paint(fill.repeat(missing));
  const rightPart =
    rightLabel !== undefined && rightLabel !== ''
      ? `${paint(' ')}${rightLabel}${paint(` ${fill}${fill}${right}`)}`
      : paint(right);
  return `${titlePart}${fillPart}${rightPart}`;
}

export function frameLines(
  ui: UiTheme,
  body: readonly string[],
  width: number,
  options: FrameOptions = {},
): string[] {
  const glyphs = options.weight === 'heavy' ? FRAME_HEAVY : FRAME_LIGHT;
  const color = options.color ?? 'fg3';
  const sides = options.sides ?? 'both';
  const paint = ui.fg(color);
  const inner = frameInnerWidth(width, sides);
  const closed = sides === 'both';
  const top = rule(
    ui,
    width,
    sides === 'none' ? glyphs.horizontal : glyphs.topLeft,
    closed ? glyphs.topRight : '',
    glyphs.horizontal,
    color,
    options.title,
    options.rightLabel,
  );
  const bottom = rule(
    ui,
    width,
    sides === 'none' ? glyphs.horizontal : glyphs.bottomLeft,
    closed ? glyphs.bottomRight : '',
    glyphs.horizontal,
    color,
  );
  const edge = paint(glyphs.vertical);
  const bg = options.bodyBg;
  const lines = body.map((line) => {
    if (sides === 'none') {
      return bg === undefined
        ? fitLine(line, inner)
        : fillLine(ui, line, inner, bg);
    }
    if (sides === 'left') {
      return bg === undefined
        ? `${edge} ${fitLine(line, inner)}`
        : `${edge}${fillLine(ui, ` ${line}`, inner + 1, bg)}`;
    }
    // A closed box is always exact so the right edge lines up.
    const content = exactWidth(
      bg === undefined ? line : fillLine(ui, line, inner, bg),
      inner,
    );
    return `${edge} ${content} ${edge}`;
  });
  return [top, ...lines, bottom];
}
