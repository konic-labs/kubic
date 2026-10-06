// Tool cards (EPIC N, issue #455; docs/ui/01-session.html 01-D, 01-E, 01-H).
//
// A tool call and its result render as one card: a header with the state
// mark, the tool name, its target and the outcome on the right; up to five
// body lines of the useful slice behind a `│` gutter; a `└` footer naming
// what is hidden. Successful reads of the workspace (`read`, `ls`, `grep`, …)
// fold to one `○` line. Pure over a UiTheme: plain text at depth none.
//
// The result text is cleaned, never shown raw: the bash record's
// `[bash exit N (shell), …]` head and its `--- stdout ---` / `--- stderr ---`
// markers become the exit code and two streams, and the exec layer's
// `[kubic: N leading chars dropped — full output: <path>]` notice becomes a
// `truncated` marker, with the path in the expanded card's footer.

import { FAIL, OK, TOOL, WARN } from '../../core/src/ui/glyphs.js';
import type { Style, UiTheme } from '../../core/src/ui/style.js';
import { spinnerFrame } from './theme.js';
import { visibleWidth, wrapTextWithAnsi } from './tui-boundary.js';
import { fitLine, leftRight } from './ui/line.js';

/** Collapsed cards show at most this many body lines. */
export const CARD_PREVIEW_LINES = 5;

const INDENT = '  ';
const COLLAPSED_MARK = '○';
const WAITING_MARK = '◆';

/** Workspace reads: a successful one folds to a single line. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'git_status',
  'git_log',
  'git_show',
  'git_diff',
]);

export interface ShellOutput {
  /** Undefined when the shell reported no code (`none`). */
  readonly exitCode: number | undefined;
  /** `timed out`, `aborted`, `output truncated`. */
  readonly flags: readonly string[];
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Where a clipped stream was spilled in full. */
  readonly spillPaths: readonly string[];
  /** A stream lost leading characters (the exec notice was present). */
  readonly clipped: boolean;
}

const BASH_HEAD = /^\[bash exit (\d+|none) \(([^)]*)\)(?:, ([^\]]*))?\]$/u;
const SPILL_NOTICE =
  /^\[kubic: \d+ leading chars dropped(?: — full output: (.+))?\]$/u;

/** The bash record as fields; undefined when the text is not one. */
export function parseShellText(text: string): ShellOutput | undefined {
  const lines = text.split('\n');
  const head = BASH_HEAD.exec(lines[0] ?? '');
  if (head === null) return undefined;
  const code = head[1];
  const flags =
    head[3] === undefined
      ? []
      : head[3]
          .split(',')
          .map((flag) => flag.trim())
          .filter((flag) => flag !== '');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spillPaths: string[] = [];
  let clipped = false;
  let into: string[] | undefined;
  for (const line of lines.slice(1)) {
    if (line === '--- stdout ---') {
      into = stdout;
      continue;
    }
    if (line === '--- stderr ---') {
      into = stderr;
      continue;
    }
    const spill = SPILL_NOTICE.exec(line);
    if (spill !== null) {
      clipped = true;
      if (spill[1] !== undefined) spillPaths.push(spill[1]);
      continue;
    }
    if (into === undefined) continue; // `(no output)`
    into.push(line);
  }
  const trim = (stream: string[]): string[] => {
    while (stream.length > 0 && (stream.at(-1) ?? '').trim() === '') {
      stream.pop();
    }
    return stream;
  };
  return {
    exitCode: code === undefined || code === 'none' ? undefined : Number(code),
    flags,
    stdout: trim(stdout),
    stderr: trim(stderr),
    spillPaths,
    clipped,
  };
}

/** `3ms`, `0.41s`, `12.3s`, `1:05`. */
export function formatToolDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) return `${value}ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(2)}s`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// A test runner's tally, in one line: node:test's `ℹ tests N` / `ℹ pass N` /
// `ℹ fail N` triple, else the first `N passed` / `N failed` line.
export function testSummary(lines: readonly string[]): string | undefined {
  const tally = (name: string): string | undefined => {
    const pattern = new RegExp(
      `^\\s*(?:ℹ\\s+|#\\s+)?${name}\\s+(\\d+)\\s*$`,
      'u',
    );
    for (const line of lines) {
      const hit = pattern.exec(line);
      if (hit !== null) return hit[1];
    }
    return undefined;
  };
  const tests = tally('tests');
  const pass = tally('pass');
  const fail = tally('fail');
  if (tests !== undefined && pass !== undefined && fail !== undefined) {
    return `tests ${tests} · pass ${pass} · fail ${fail}`;
  }
  for (const line of lines) {
    const passed = /\b(\d+)\s+passed\b/iu.exec(line)?.[1];
    const failed = /\b(\d+)\s+failed\b/iu.exec(line)?.[1];
    if (passed === undefined && failed === undefined) continue;
    const parts: string[] = [];
    if (passed !== undefined) parts.push(`${passed} passed`);
    if (failed !== undefined) parts.push(`${failed} failed`);
    return parts.join(' · ');
  }
  return undefined;
}

const STACK_FRAME = /^\s*at\s/u;

const ERROR_LINE =
  /(✖|✗|✕|×|\bFAIL(?:ED)?\b|\bERR!|\berror\b|Error\b|Traceback|panic:|\bnot ok\b)/u;

interface BodyLine {
  readonly text: string;
  readonly style: Style;
}

// The lines worth showing first: on a failure the error lines (each with
// the more-indented line after it), on success the head.
function usefulSlice(
  lines: readonly BodyLine[],
  failed: boolean,
  limit: number,
): BodyLine[] {
  if (!failed) return lines.slice(0, limit);
  const picked = new Set<number>();
  const indent = (text: string): number => /^\s*/u.exec(text)?.[0].length ?? 0;
  lines.forEach((line, index) => {
    if (picked.size >= limit || !ERROR_LINE.test(line.text)) return;
    picked.add(index);
    const next = lines[index + 1];
    // The more-indented line after an error is its detail — unless it is a
    // stack frame, which only buries the message.
    if (
      next !== undefined &&
      picked.size < limit &&
      indent(next.text) > indent(line.text) &&
      !STACK_FRAME.test(next.text)
    ) {
      picked.add(index + 1);
    }
  });
  if (picked.size === 0) return lines.slice(-limit);
  return [...picked]
    .sort((a, b) => a - b)
    .map((index) => lines[index] as BodyLine);
}

export interface ToolCardInput {
  readonly name: string;
  /** The argument summary (path, command, pattern, …). */
  readonly target?: string;
  /** The result text; undefined while the call runs. */
  readonly output?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
  /** How long a running call has run (the running header's clock). */
  readonly runningMs?: number;
  /** The call waits on an approval. */
  readonly waiting?: boolean;
  readonly expanded: boolean;
  /** The expand key's cap (`^X`); empty hides the hint. */
  readonly expandKey?: string;
}

function readMeta(name: string, output: string): string {
  const first = output.split('\n', 1)[0] ?? '';
  if (name === 'read') {
    const range = /: lines (\d+)-(\d+) of /u.exec(first);
    if (range !== null) {
      const count = Number(range[2]) - Number(range[1]) + 1;
      return `${count} line${count === 1 ? '' : 's'}`;
    }
    if (/: empty \(0 lines\)\]$/u.test(first)) return 'empty';
    return '';
  }
  if (name === 'grep') {
    return /: (\d+ match(?:es)?)/u.exec(first)?.[1] ?? '';
  }
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) return `${value.length} ${key}`;
      }
    }
  } catch {
    // Not JSON: count the lines instead.
  }
  const count = output.split('\n').filter((line) => line !== '').length;
  return `${count} line${count === 1 ? '' : 's'}`;
}

export function renderToolCard(
  ui: UiTheme,
  card: ToolCardInput,
  width: number,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const done = card.output !== undefined;
  const shell =
    card.output === undefined ? undefined : parseShellText(card.output);
  const failed =
    card.isError === true ||
    (shell?.exitCode !== undefined && shell.exitCode !== 0) ||
    shell?.flags.includes('timed out') === true ||
    shell?.flags.includes('aborted') === true;
  const duration =
    card.durationMs === undefined
      ? ''
      : ui.fg('fg2')(` · ${formatToolDuration(card.durationMs)}`);
  const target =
    card.target === undefined || card.target === ''
      ? ''
      : ui.fg('fg1')(`  ${card.target}`);
  // Collapsed read: one line, no body.
  if (
    done &&
    !failed &&
    !card.expanded &&
    READ_TOOLS.has(card.name) &&
    shell === undefined
  ) {
    const meta = readMeta(card.name, card.output ?? '');
    const left = `${INDENT}${ui.fg('fg2')(COLLAPSED_MARK)} ${ui.fg('fg1')(card.name)}${card.target === undefined || card.target === '' ? '' : ui.fg('fg2')(`  ${card.target}`)}`;
    const right = `${ui.fg('fg2')(meta)}${meta === '' ? (card.durationMs === undefined ? '' : ui.fg('fg2')(formatToolDuration(card.durationMs))) : duration} `;
    return [leftRight(left, right.trim() === '' ? '' : right, w)];
  }
  // Header: state mark, name, target; outcome and duration on the right.
  let mark: string;
  let outcome: string;
  if (card.waiting === true) {
    mark = ui.fg('warn')(WAITING_MARK);
    outcome = ui.fg('warn')('waiting for approval');
  } else if (!done) {
    mark = ui.fg('accent')(spinnerFrame(card.runningMs ?? 0));
    outcome = ui.fg('fg2')(
      card.runningMs === undefined
        ? 'running'
        : `running · ${formatToolDuration(card.runningMs)}`,
    );
  } else {
    mark = ui.fg(failed ? 'err' : 'ok')(TOOL);
    const parts: string[] = [];
    if (shell?.clipped === true || shell?.flags.includes('output truncated')) {
      parts.push(ui.fg('fg2')('truncated'));
    }
    if (shell?.flags.includes('timed out') === true) {
      parts.push(ui.fg('err')(`${FAIL} timed out`));
    } else if (shell?.flags.includes('aborted') === true) {
      parts.push(ui.fg('warn')(`${WARN} aborted`));
    } else if (shell?.exitCode !== undefined) {
      parts.push(
        shell.exitCode === 0
          ? ui.fg('ok')(`${OK} exit 0`)
          : ui.fg('err')(`${FAIL} exit ${shell.exitCode}`),
      );
    } else if (card.isError === true) {
      parts.push(ui.fg('err')(`${FAIL} failed`));
    }
    outcome = parts.join(ui.fg('fg2')(' · '));
  }
  const name = `${INDENT}${mark} ${ui.style({ fg: 'fg0', bold: true })(card.name)}`;
  const headRight = `${outcome}${done ? duration : ''} `;
  const right = headRight.trim() === '' ? '' : headRight;
  const gutter = `${INDENT}${ui.fg('fg3')('│')} `;
  const elbow = `${INDENT}${ui.fg('fg3')('└')} `;
  const bodyWidth = Math.max(1, w - visibleWidth(gutter));
  const out: string[] = [];
  if (
    card.expanded &&
    target !== '' &&
    visibleWidth(`${name}${target}`) + 1 + visibleWidth(right) > w
  ) {
    // Expanded, a target too long for the header wraps under it (#300):
    // the operator expanded to read exactly that command or path.
    out.push(leftRight(name, right, w));
    for (const row of wrapTextWithAnsi(card.target ?? '', bodyWidth)) {
      out.push(fitLine(`${gutter}${ui.fg('fg1')(row)}`, w));
    }
  } else {
    out.push(leftRight(`${name}${target}`, right, w));
  }
  if (!done) return out;
  // Body lines: the streams of a shell record (stderr after stdout), else
  // the result text.
  const lines: BodyLine[] =
    shell !== undefined
      ? [
          ...shell.stdout.map((text) => ({ text, style: ui.fg('fg2') })),
          ...shell.stderr.map((text) => ({ text, style: ui.fg('fg1') })),
        ]
      : (card.output ?? '')
          .split('\n')
          .filter(
            (text, index, all) => !(text === '' && index === all.length - 1),
          )
          .map((text) => ({
            text,
            style: card.isError === true ? ui.fg('fg1') : ui.fg('fg2'),
          }));
  if (card.expanded) {
    for (const line of lines) {
      for (const row of wrapTextWithAnsi(line.text, bodyWidth)) {
        out.push(fitLine(`${gutter}${line.style(row)}`, w));
      }
    }
    for (const path of shell?.spillPaths ?? []) {
      out.push(
        fitLine(
          `${elbow}${ui.fg('fg2')('full output: ')}${ui.fg('fg1')(path)}`,
          w,
        ),
      );
    }
    return out;
  }
  const summary =
    shell !== undefined
      ? testSummary([...shell.stdout, ...shell.stderr])
      : undefined;
  if (!failed && summary !== undefined) {
    out.push(fitLine(`${elbow}${ui.fg('fg1')(summary)}`, w));
    return out;
  }
  const room =
    summary === undefined ? CARD_PREVIEW_LINES : CARD_PREVIEW_LINES - 1;
  const shown = usefulSlice(lines, failed, room);
  let cut = false;
  for (const line of shown) {
    if (visibleWidth(line.text) > bodyWidth) cut = true;
    out.push(fitLine(`${gutter}${line.style(line.text)}`, w));
  }
  if (summary !== undefined) {
    out.push(fitLine(`${gutter}${ui.fg('fg1')(summary)}`, w));
  }
  const hidden = lines.length - shown.length;
  if (hidden > 0 || cut) {
    const parts: string[] = [];
    if (hidden > 0) parts.push(`+${hidden} line${hidden === 1 ? '' : 's'}`);
    if (cut) parts.push('wide lines cut');
    const key =
      card.expandKey === undefined || card.expandKey === ''
        ? ''
        : `   ${ui.fg('fg1')(card.expandKey)}${ui.fg('fg2')(' expand')}`;
    out.push(fitLine(`${elbow}${ui.fg('fg2')(parts.join(' · '))}${key}`, w));
  }
  return out;
}
