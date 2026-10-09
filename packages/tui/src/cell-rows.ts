// The rows of the transcript's collapsible cells: reasoning, a tool call
// with its result, and a compaction summary. Collapsed, each says what it
// hides and which key expands it.

import type { TuiTheme } from './theme.js';
import { renderToolCard } from './tool-card.js';
import type { ToolCallState, TranscriptEntry } from './transcript-entry.js';
import { TOOL_OUTPUT_PREVIEW_LINES } from './transcript-entry.js';
import {
  firstSentence,
  fit,
  formatThinkingTime,
  stripPrefix,
  THINKING_MARK,
} from './transcript-text.js';
import { visibleWidth } from './tui-boundary.js';
import { leftRight, wrapStyled } from './ui/line.js';

// Reasoning collapses to its first sentence; ^X shows
// all of it, italic, behind the gutter.
export function thinkingRows(
  cell: TranscriptEntry,
  width: number,
  theme: TuiTheme,
  expanded: boolean,
  expandKey: () => string,
): string[] {
  const ui = theme.ui;
  const muted = ui.style({ fg: 'fg2', italic: true });
  const label =
    cell.durationMs === undefined
      ? 'thinking'
      : `thought for ${formatThinkingTime(cell.durationMs)}`;
  const mark = `  ${ui.fg('fg2')(THINKING_MARK)} `;
  if (expanded) {
    const out = [fit(`${mark}${ui.fg('fg2')(label)}`, width)];
    const gutter = `  ${ui.fg('fg3')('│')} `;
    const room = Math.max(1, width - 4);
    for (const line of cell.markdown.split('\n')) {
      for (const row of wrapStyled(line, room)) {
        out.push(fit(`${gutter}${muted(row)}`, width));
      }
    }
    return out;
  }
  const first = firstSentence(cell.markdown);
  const key = expandKey();
  const left = `${mark}${muted(first === '' ? label : `${label} — ${first}`)}`;
  const right = key === '' ? '' : `${ui.fg('fg3')(`${key} expand`)} `;
  return [
    right !== '' && visibleWidth(left) + 2 + visibleWidth(right) <= width
      ? leftRight(left, right, width)
      : fit(left, width),
  ];
}

// A call and its result as one card.
export function toolCardRows(
  call: TranscriptEntry | undefined,
  result: TranscriptEntry | undefined,
  width: number,
  theme: TuiTheme,
  expanded: boolean,
  toolState: ((toolCallId: string) => ToolCallState | undefined) | undefined,
  expandKey: () => string,
): string[] {
  const toolCallId = call?.toolCallId ?? result?.toolCallId;
  const state = toolCallId === undefined ? undefined : toolState?.(toolCallId);
  return renderToolCard(
    theme.ui,
    {
      name: call === undefined ? 'result' : stripPrefix(call.markdown, 'tool '),
      ...(call?.detail === undefined ? {} : { target: call.detail }),
      ...(result === undefined ? {} : { output: result.markdown }),
      ...(result?.isError === true ? { isError: true } : {}),
      ...(result?.display === undefined ? {} : { display: result.display }),
      ...(state?.durationMs === undefined
        ? {}
        : { durationMs: state.durationMs }),
      ...(state?.runningMs === undefined ? {} : { runningMs: state.runningMs }),
      ...(state?.waiting === true ? { waiting: true } : {}),
      expanded,
      expandKey: expandKey(),
    },
    width,
  );
}

// A compaction summary: collapsed shows the first rows behind a
// gutter and says what it hides; expanded wraps everything.
export function pushBlockRows(
  out: string[],
  lines: string[],
  width: number,
  theme: TuiTheme,
  expanded: boolean,
  expandKey: () => string,
): void {
  const ui = theme.ui;
  const gutter = `  ${ui.fg('fg3')('│')} `;
  const bodyWidth = Math.max(1, width - visibleWidth(gutter));
  const shown = expanded ? lines : lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
  let clipped = false;
  for (const line of shown) {
    if (expanded) {
      for (const row of wrapStyled(line, bodyWidth)) {
        out.push(fit(`${gutter}${ui.fg('fg2')(row)}`, width));
      }
      continue;
    }
    if (visibleWidth(line) > bodyWidth) clipped = true;
    out.push(fit(`${gutter}${ui.fg('fg2')(line)}`, width));
  }
  const hidden = lines.length - shown.length;
  if (hidden > 0 || clipped) {
    const parts: string[] = [];
    if (hidden > 0) parts.push(`+${hidden} line${hidden === 1 ? '' : 's'}`);
    if (clipped) parts.push('wide lines cut');
    const key = expandKey();
    out.push(
      fit(
        `  ${ui.fg('fg3')('└')} ${ui.fg('fg2')(parts.join(' · '))}${key === '' ? '' : `   ${ui.fg('fg1')(key)}${ui.fg('fg2')(' expand')}`}`,
        width,
      ),
    );
  }
}
