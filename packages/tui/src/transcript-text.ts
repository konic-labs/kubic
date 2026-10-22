// Pieces the transcript's cells are drawn with: the receipt line, prompt
// stamps, the markdown theme, and rows fitted to the width.

import type { TuiTheme } from './theme.js';
import { formatToolDuration } from './tool-card.js';
import type { TurnReceipt } from './transcript-entry.js';
import type { MarkdownTheme } from './tui-boundary.js';
import { truncateToWidth, visibleWidth } from './tui-boundary.js';
import { highlightCode } from './ui/highlight.js';
import { leftRight } from './ui/line.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR is the point
const SGR = /\u001b\[[0-9;]*m/gu;

export function plainText(line: string): string {
  return line.replace(SGR, '');
}

// The selected block's edge: its first visible cell becomes the mark; the
// line's leading colour (a surface) is kept.
export function withEdge(line: string, mark: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR is the point
  const hit = /^((?:\u001b\[[0-9;]*m)*)[\s\S]/u.exec(line);
  if (hit === null) return mark;
  return `${hit[1] ?? ''}${mark}${line.slice(hit[0].length)}`;
}

export const PROMPT_MARK = '›';
export const THINKING_MARK = '⋯';

/** `4.1s`, `1:05`. */
export function formatThinkingTime(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return formatToolDuration(value);
}

/** The reasoning's first sentence, on one line. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = /[.!?](?:\s|$)/u.exec(flat);
  return end === null ? flat : flat.slice(0, end.index + 1);
}

/**
 * `✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031` with
 * `^O review diff   /undo revert` on the right when files changed; the
 * right part drops first on a narrow terminal.
 */
export function renderReceipt(
  ui: TuiTheme['ui'],
  receipt: TurnReceipt,
  width: number,
): string {
  const time = formatThinkingTime(receipt.elapsedMs);
  if (receipt.outcome !== 'completed') {
    const failed = receipt.outcome === 'failed';
    const head = failed
      ? `${ui.fg('err')('✕')} ${ui.fg('fg1')(`turn failed · ${time}`)}`
      : `${ui.fg('fg2')('○')} ${ui.fg('fg1')(`turn cancelled · ${time}`)}`;
    const detail =
      receipt.detail === undefined || receipt.detail === ''
        ? ''
        : ui.fg('fg2')(` · ${receipt.detail}`);
    return fit(`  ${head}${detail}`, width);
  }
  const parts = [`turn ${time}`];
  if (receipt.tools > 0) {
    parts.push(`${receipt.tools} tool${receipt.tools === 1 ? '' : 's'}`);
  }
  let files = '';
  if (receipt.files > 0) {
    files = ` · ${receipt.files} file${receipt.files === 1 ? '' : 's'}`;
  }
  const counts =
    receipt.files > 0 &&
    receipt.added !== undefined &&
    receipt.removed !== undefined
      ? ` ${ui.fg('add')(`+${receipt.added}`)} ${ui.fg('del')(`−${receipt.removed}`)}`
      : '';
  const cost = ui.fg('fg1')(
    ` · $${receipt.costUsd < 1 ? receipt.costUsd.toFixed(3) : receipt.costUsd.toFixed(2)}`,
  );
  const left = `  ${ui.fg('ok')('✓')} ${ui.fg('fg1')(`${parts.join(' · ')}${files}`)}${counts}${cost}`;
  const diffKey = receipt.diffKey ?? '';
  const right =
    receipt.files === 0
      ? ''
      : `${diffKey === '' ? '' : `${ui.fg('fg1')(diffKey)}${ui.fg('fg2')(' review diff')}   `}${ui.fg('fg1')('/undo')}${ui.fg('fg2')(' revert')} `;
  return right !== '' && visibleWidth(left) + 2 + visibleWidth(right) <= width
    ? leftRight(left, right, width)
    : fit(left, width);
}

/** Local `HH:MM:SS` for the prompt block. */
export function formatPromptTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// The label in front of a queued follow-up's first line. Plain
// ASCII, because it prefixes untrusted prompt text and must never be
// confused with a committed prompt row (`›`).
/** @internal */
export const QUEUED_LABEL = 'queued:';

// Markdown on the design tokens — calm headings, inline
// code on bg2, fenced code in a fg3 `┌ lang` / `└` frame with highlighted
// lines behind a `│` gutter, info links, fg2 `•` bullets, fg3 quote gutters.
export function markdownThemeFor(theme: TuiTheme): MarkdownTheme {
  const ui = theme.ui;
  // Pi draws a fence's opening and closing border through one hook; the two
  // calls alternate, and a fence with no language passes the same text both
  // times, so the side is tracked here.
  let inFence = false;
  return {
    heading: ui.style({ fg: 'fg0', bold: true }),
    link: ui.fg('info'),
    linkUrl: ui.fg('fg2'),
    code: (text: string): string =>
      ui.style({ fg: 'fg0', bg: 'bg2' })(` ${text} `),
    codeBlock: ui.fg('fg1'),
    codeBlockBorder: (text: string): string => {
      const opening = !inFence;
      inFence = !inFence;
      const language = text.replace(/^`+/u, '').trim();
      return ui.fg('fg3')(
        opening ? (language === '' ? '┌' : `┌ ${language}`) : '└',
      );
    },
    codeBlockIndent: ui.fg('fg3')('│ '),
    highlightCode: (code: string, language?: string): string[] =>
      highlightCode(ui, code, language),
    quote: ui.fg('fg1'),
    quoteBorder: ui.fg('fg3'),
    hr: ui.fg('fg3'),
    listBullet: (marker: string): string =>
      ui.fg('fg2')(marker.replace(/^[-*+](?=\s|$)/u, '•')),
    bold: ui.style({ fg: 'fg0', bold: true }),
    italic: ui.style({ fg: 'fg1', italic: true }),
    strikethrough: ui.style({ fg: 'fg2', strike: true }),
    underline: ui.style({ underline: true }),
  };
}

export function stripPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

// One queued row's text: the label plus the prompt's first line. A multi-line
// draft is summarised, not dumped — the committed entry shows it in full.
export function queuedLine(prompt: string): string {
  const first = prompt.split('\n', 1)[0] ?? '';
  return `${QUEUED_LABEL} ${first}`;
}

export function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '…');
}

// Cache keys are `${theme.level}\u0000${cell.id}`: the id is everything after
// the first NUL (entry ids never contain one).
// Cache entries are per theme AND depth — a live theme switch
// at the same depth must repaint, not reuse the old colours. Names hold no
// NUL, so the cell id is still everything after the first one.
export function themeKey(theme: TuiTheme): string {
  return `${theme.ui.name} ${theme.level}`;
}

export function cellIdOf(key: string): string {
  const at = key.indexOf('\u0000');
  return at === -1 ? key : key.slice(at + 1);
}

// The image cache keys are `cellId\u0000index`: the id is everything
// before the last separator, so the cell's components can be pruned with the
// markdown caches when a snapshot drops the cell.
export function imageCellIdOf(key: string): string {
  const at = key.lastIndexOf('\u0000');
  return at === -1 ? key : key.slice(0, at);
}
