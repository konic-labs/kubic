// The framed editor and the working line (EPIC N, issue #454; docs/ui
// 01-K and the mid-turn frame).
//
// Pi's Editor draws a rule above and below its lines and nothing at the
// sides. The frame closes the box: ` ┌─…─┐ `, ` │ › <text>   @ file  / cmd │ `,
// ` └─…─┘ `. The caret is the one hot colour (accent, bold) while the app is
// idle; mid-turn the box is a queue box — an fg2 caret and, on an empty
// draft, an italic placeholder. Pi's own scroll indicators (`─── ↑ 3 more`)
// stay inside the rules.
//
// The rules are recognised by a zero-width marker the editor theme puts on
// them (an APC string, the same kind of sequence as Pi's cursor marker, which
// width measuring already skips), so a draft line made of `─` is never taken
// for one. Autocomplete rows Pi renders below its bottom rule stay below the
// box, aligned with the text.

import { formatTokens } from '../../core/src/cli/kit.js';
import { FRAME_LIGHT, RETURN_KEY } from '../../core/src/ui/glyphs.js';
import type { UiTheme } from '../../core/src/ui/style.js';
import { spinnerFrame } from './theme.js';
import { visibleWidth } from './tui-boundary.js';
import { fitLine, leftRight } from './ui/line.js';

/** Marks Pi's editor rules (zero width; never reaches the terminal). */
export const RULE_MARK = '\u001b_kubic:rule\u0007';

/** Cells the frame adds around the editor: margins, sides, caret, gap. */
export const EDITOR_FRAME_CELLS = 8;

/** Where the editor's own text starts inside the frame. */
const TEXT_COLUMN = 5;

export interface EditorFrameOptions {
  /** A turn is running: the box is a queue box. */
  readonly busy: boolean;
  /** The draft is empty (the placeholder may show). */
  readonly empty: boolean;
  /** Right-aligned on the first line while it fits (idle only). */
  readonly hint?: string;
  /** Shown on an empty draft while busy. */
  readonly placeholder?: string;
}

function trimTrailingSpaces(line: string): string {
  return line.replace(/ +$/, '');
}

/**
 * The editor's lines (rendered at `width - EDITOR_FRAME_CELLS`) inside the
 * frame. Below the minimum width the lines pass through unframed.
 */
export function frameEditorLines(
  ui: UiTheme,
  lines: readonly string[],
  width: number,
  options: EditorFrameOptions,
): string[] {
  const inner = width - EDITOR_FRAME_CELLS;
  if (inner < 1) return lines.map((line) => line.replaceAll(RULE_MARK, ''));
  const paint = ui.fg('fg3');
  const caretStyle = options.busy
    ? ui.fg('fg2')
    : ui.style({ fg: 'accent', bold: true });
  const out: string[] = [];
  let rules = 0;
  let contentRow = 0;
  for (const line of lines) {
    if (line.startsWith(RULE_MARK)) {
      const rule = `${FRAME_LIGHT.horizontal.repeat(2)}${line.slice(RULE_MARK.length)}${FRAME_LIGHT.horizontal.repeat(2)}`;
      const [left, right] =
        rules === 0
          ? [FRAME_LIGHT.topLeft, FRAME_LIGHT.topRight]
          : [FRAME_LIGHT.bottomLeft, FRAME_LIGHT.bottomRight];
      out.push(` ${paint(`${left}${fitLine(rule, inner + 4)}${right}`)} `);
      rules += 1;
      continue;
    }
    if (rules !== 1) {
      // Autocomplete rows (after the bottom rule), aligned with the text.
      out.push(`${' '.repeat(TEXT_COLUMN)}${line}`);
      continue;
    }
    const first = contentRow === 0;
    contentRow += 1;
    let content = line;
    if (first && options.busy && options.empty && options.placeholder) {
      const head = trimTrailingSpaces(line);
      const room = inner - visibleWidth(head);
      const text =
        room > 1
          ? ui.style({ fg: 'fg2', italic: true })(
              fitLine(options.placeholder, room - 1),
            )
          : '';
      content = `${head}${text === '' ? '' : ` ${text}`}`;
    } else if (first && !options.busy && options.hint) {
      const head = trimTrailingSpaces(line);
      const hint = ui.fg('fg3')(options.hint);
      const used = visibleWidth(head);
      const hintWidth = visibleWidth(hint);
      if (used + 2 + hintWidth <= inner) {
        content = `${head}${' '.repeat(inner - used - hintWidth)}${hint}`;
      }
    }
    const pad = Math.max(0, inner - visibleWidth(content));
    const caret = first ? caretStyle(' › ') : '   ';
    out.push(
      ` ${paint(FRAME_LIGHT.vertical)}${caret}${content}${' '.repeat(pad)} ${paint(FRAME_LIGHT.vertical)} `,
    );
  }
  return out;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatTurnClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

export interface WorkingInfo {
  readonly elapsedMs: number;
  /** This turn's tokens, once a usage row reported them. */
  readonly input?: number;
  readonly output?: number;
  /** Tool calls this turn has made. */
  readonly tools?: number;
  /** The interrupt key's cap (`esc`); empty when unbound. */
  readonly interruptKey?: string;
}

/**
 * `⠹ Working · 0:12 · ↑ 9.2k ↓ 640 tok · 3 tools     esc interrupt   ⏎ queue
 * a message` — the line above the editor while a turn runs. The keys on the
 * right drop first when the line is narrow.
 */
export function renderWorkingLine(
  ui: UiTheme,
  info: WorkingInfo,
  width: number,
): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const facts = [formatTurnClock(info.elapsedMs)];
  if (info.input !== undefined && info.output !== undefined) {
    facts.push(
      `↑ ${formatTokens(info.input)} ↓ ${formatTokens(info.output)} tok`,
    );
  }
  if (info.tools !== undefined && info.tools > 0) {
    facts.push(`${info.tools} tool${info.tools === 1 ? '' : 's'}`);
  }
  const left = `${ui.fg('accent')(` ${spinnerFrame(info.elapsedMs)} `)}${ui.fg('fg1')('Working')}${ui.fg('fg2')(` · ${facts.join(' · ')}`)}`;
  const keys: string[] = [];
  const interrupt = info.interruptKey ?? 'esc';
  if (interrupt !== '') {
    keys.push(`${ui.fg('fg1')(interrupt)}${ui.fg('fg2')(' interrupt')}`);
  }
  keys.push(`${ui.fg('fg1')(RETURN_KEY)}${ui.fg('fg2')(' queue a message')}`);
  for (let count = keys.length; count > 0; count -= 1) {
    const right = `${keys.slice(0, count).join('   ')} `;
    if (visibleWidth(left) + 2 + visibleWidth(right) <= w) {
      return leftRight(left, right, w);
    }
  }
  return fitLine(left, w);
}
