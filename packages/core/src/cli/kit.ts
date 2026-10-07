// The CLI output kit. Pure helpers
// that render the 06 look from the shared tokens: a brand heading, section
// labels, status marks, aligned rows, receipts, next actions, error blocks
// and hint lines. Every helper returns strings without a trailing newline;
// the caller prints through its own `out`/`err` channel.
//
// The kit is the TTY layer. Callers choose it only when `isFancy(stream)` is
// true; pipes, `--json` and NO_COLOR keep each command's plain text, which
// the binary contract and scripts depend on.

import {
  BRAND,
  COLLAPSED,
  FAIL,
  INFO,
  OK,
  SPINNER_FRAMES,
  WARN,
} from '../ui/glyphs.js';
import { type CliTheme, themeFor } from './theme.js';
import { padVisible } from './width.js';

type Env = Readonly<Record<string, string | undefined>>;

/** True when a stream should get the kit rendering: a coloured TTY. */
export function isFancy(
  stream: { readonly isTTY?: boolean },
  env: Env = process.env,
): boolean {
  return stream.isTTY === true && themeFor(stream, env).enabled;
}

export type MarkKind = 'ok' | 'warn' | 'fail' | 'skip' | 'info' | 'working';

/** The status glyph for a kind, in its colour (`working` takes a frame). */
export function statusMark(theme: CliTheme, kind: MarkKind, frame = 0): string {
  const ui = theme.ui;
  switch (kind) {
    case 'ok':
      return ui.fg('ok')(OK);
    case 'warn':
      return ui.fg('warn')(WARN);
    case 'fail':
      return ui.fg('err')(FAIL);
    case 'skip':
      return ui.fg('fg2')(COLLAPSED);
    case 'info':
      return ui.fg('info')(INFO);
    case 'working':
      return ui.fg('accent')(
        SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '',
      );
  }
}

/** `■ kubic <title> · part · part` — brand in accent, parts muted. */
export function brandHeading(
  theme: CliTheme,
  title: string,
  parts: readonly string[] = [],
): string {
  const ui = theme.ui;
  const head = ui.style({ fg: 'accent', bold: true })(
    `${BRAND} kubic ${title}`,
  );
  if (parts.length === 0) return head;
  return `${head} ${ui.fg('fg2')(`· ${parts.join(' · ')}`)}`;
}

/** An uppercase muted label padded to a column: `RUNTIME     `. */
export function sectionLabel(
  theme: CliTheme,
  label: string,
  width = 12,
): string {
  return theme.ui.style({ fg: 'fg2', bold: true })(
    padVisible(label.toUpperCase(), width),
  );
}

// Inline `code` in a hint renders without backticks in fg1; the rest is fg2.
function hintText(theme: CliTheme, text: string): string {
  const ui = theme.ui;
  return text
    .split(/(`[^`]+`)/)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length >= 2
        ? ui.fg('fg1')(part.slice(1, -1))
        : ui.fg('fg2')(part),
    )
    .join('');
}

/** A muted hint line; `code` spans are highlighted. */
export function hintLine(theme: CliTheme, text: string, indent = 2): string {
  return `${' '.repeat(indent)}${hintText(theme, text)}`;
}

/** A muted key padded to `keyWidth`, then the value in primary text. */
export function kvLine(
  theme: CliTheme,
  key: string,
  value: string,
  keyWidth = 0,
): string {
  return `${theme.ui.fg('fg2')(padVisible(key, keyWidth))} ${theme.ui.fg('fg0')(value)}`;
}

/**
 * Rows of `LABEL  content`: the label column is a section label, multi-line
 * content continues under the content column.
 */
export function alignedRows(
  theme: CliTheme,
  rows: readonly (readonly [label: string, content: string])[],
  labelWidth = 12,
): string[] {
  const lines: string[] = [];
  for (const [label, content] of rows) {
    const [first = '', ...rest] = content.split('\n');
    lines.push(`${sectionLabel(theme, label, labelWidth)}${first}`);
    for (const line of rest) lines.push(`${' '.repeat(labelWidth)}${line}`);
  }
  return lines;
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const seconds = Math.round(safe / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.max(0, Math.round(count)));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export interface ReceiptInput {
  readonly ok: boolean;
  /** Defaults to `done` / `failed`. */
  readonly label?: string;
  readonly durationMs?: number;
  readonly tools?: number;
  readonly files?: number;
  readonly added?: number;
  readonly removed?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  /** A machine outcome code shown after a failure label. */
  readonly outcome?: string;
}

/** `✓ done 18.4s · 4 tools · 1 file +1 −1 · ↑ 9.2k ↓ 640 tok · $0.031`. */
export function receipt(theme: CliTheme, input: ReceiptInput): string {
  const ui = theme.ui;
  const label = input.label ?? (input.ok ? 'done' : 'failed');
  const head = input.ok
    ? `${statusMark(theme, 'ok')} ${ui.fg('ok')(label)}`
    : `${statusMark(theme, 'fail')} ${ui.style({ fg: 'err', bold: true })(label)}`;
  const parts: string[] = [];
  if (input.durationMs !== undefined) {
    parts.push(ui.fg('fg1')(formatDuration(input.durationMs)));
  }
  if (!input.ok && input.outcome !== undefined && input.outcome !== '') {
    parts.push(ui.fg('err')(input.outcome));
  }
  if (input.tools !== undefined) {
    parts.push(
      ui.fg('fg2')(`${input.tools} tool${input.tools === 1 ? '' : 's'}`),
    );
  }
  if (input.files !== undefined && input.files > 0) {
    let files = ui.fg('fg2')(
      `${input.files} file${input.files === 1 ? '' : 's'}`,
    );
    if (input.added !== undefined)
      files += ` ${ui.fg('add')(`+${input.added}`)}`;
    if (input.removed !== undefined) {
      files += ` ${ui.fg('del')(`−${input.removed}`)}`;
    }
    parts.push(files);
  }
  if (input.tokensIn !== undefined || input.tokensOut !== undefined) {
    parts.push(
      ui.fg('fg2')(
        `↑ ${formatTokens(input.tokensIn ?? 0)} ↓ ${formatTokens(input.tokensOut ?? 0)} tok`,
      ),
    );
  }
  if (input.costUsd !== undefined)
    parts.push(ui.fg('fg1')(formatCost(input.costUsd)));
  const separator = ui.fg('fg2')(' · ');
  return parts.length === 0 ? head : `${head} ${parts.join(separator)}`;
}

/** `review kubic diff   revert kubic undo` — labels muted, commands fg1. */
export function nextActions(
  theme: CliTheme,
  actions: readonly (readonly [label: string, command: string])[],
  indent = 2,
): string {
  const ui = theme.ui;
  return `${' '.repeat(indent)}${actions
    .map(
      ([label, command]) => `${ui.fg('fg2')(label)} ${ui.fg('fg1')(command)}`,
    )
    .join('   ')}`;
}

export interface ErrorBlockInput {
  /** What failed: `unknown model`, `no model provider has a key`. */
  readonly message: string;
  /** The offending value, shown in primary text after the message. */
  readonly subject?: string;
  /** Which input carried it: `--model`, `KUBIC_MODEL`, `[model] in …`. */
  readonly source?: string;
  /** What to do next; `code` spans are highlighted. */
  readonly hints?: readonly string[];
  readonly exitCode?: number;
  /** The machine code, e.g. `provider_probe_failed`. */
  readonly code?: string;
}

/**
 * `✕ unknown model openai/gpt-x (from --model)`, indented hints, and a faint
 * `exit 6 · provider_probe_failed` line.
 */
export function errorBlock(theme: CliTheme, input: ErrorBlockInput): string[] {
  const ui = theme.ui;
  let head = `${ui.fg('err')(FAIL)} ${ui.style({ fg: 'err', bold: true })(input.message)}`;
  if (input.subject !== undefined && input.subject !== '') {
    head += ` ${ui.fg('fg0')(input.subject)}`;
  }
  if (input.source !== undefined && input.source !== '') {
    head += ` ${ui.fg('fg2')(`(from ${input.source})`)}`;
  }
  const lines = [head];
  for (const hint of input.hints ?? []) lines.push(hintLine(theme, hint));
  const meta = [
    input.exitCode === undefined ? undefined : `exit ${input.exitCode}`,
    input.code,
  ].filter((part): part is string => part !== undefined && part !== '');
  if (meta.length > 0) lines.push(`  ${ui.fg('fg3')(meta.join(' · '))}`);
  return lines;
}
