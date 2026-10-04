// Coarse lane-entry cells for the transcript (issue #88).
// §15.2 replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; §15 routes no message
// events, so the transcript is built from the lane's own entries). Pure:
// entries in, cells out, no I/O.
//
// The lane hands entries back newest-first (Pi scans the branch from the
// tip), so cells are ordered by `seq` ascending — the transcript reads
// top-to-bottom as the session happened. Every cell id is derived from the
// entry id plus the part index, so a re-render replaces cells instead of
// duplicating them.

import type { TranscriptEntry, TranscriptEntryKind } from './transcript.js';

// Entry shapes are structural on purpose: the tui package must never import
// worker/host implementation (dep-lint), so only the fields read here are
// typed.
export interface LaneEntryLike {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
}

// Upper bound on the output a cell carries (the view collapses it further
// to TOOL_OUTPUT_PREVIEW_LINES unless the operator expands it with Ctrl-X).
export const TOOL_RESULT_MAX_CHARS = 20_000;
export const TOOL_RESULT_MAX_LINES = 400;
export const TOOL_DETAIL_MAX_CHARS = 120;

const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';
const ROLE_TOOL_RESULT = 'toolResult';

export const PROMPT_PREFIX = '› ';
export const TOOL_CALL_PREFIX = 'tool ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type !== 'text') return undefined;
  return typeof part.text === 'string' ? part.text : undefined;
}

function nameOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type !== 'toolCall') return undefined;
  return typeof part.name === 'string' ? part.name : undefined;
}

function toolCallIdOf(part: unknown, index: number): string {
  if (!isRecord(part)) return String(index);
  return typeof part.id === 'string' && part.id !== ''
    ? part.id
    : String(index);
}

function argumentsOf(part: unknown): unknown {
  return isRecord(part) ? part.arguments : undefined;
}

// A one-line summary of a tool call's arguments: the argument an operator
// recognises first (path, command, pattern, …), else compact JSON. Untrusted
// (model-authored), so sanitized and newline-collapsed.
const PRIMARY_ARGUMENT_KEYS = [
  'command',
  'path',
  'file_path',
  'pattern',
  'query',
  'url',
] as const;

export function summarizeToolArguments(args: unknown): string {
  let summary = '';
  if (isRecord(args)) {
    const key = PRIMARY_ARGUMENT_KEYS.find(
      (candidate) => typeof args[candidate] === 'string',
    );
    if (key !== undefined) {
      summary = args[key] as string;
    } else if (Object.keys(args).length > 0) {
      summary = JSON.stringify(args);
    }
  } else if (typeof args === 'string') {
    summary = args;
  }
  const oneLine = sanitizeLaneText(summary).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TOOL_DETAIL_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TOOL_DETAIL_MAX_CHARS - 1)}…`;
}

// The one-line OUTCOME of a finished tool call (issue #345; §18): the test
// summary the operator reads first (`17 passed`), else a non-zero shell exit
// code. Both are derived from the tool-result entry, which is untrusted tool
// output, so the returned text is sanitized and newline-collapsed before it
// reaches the tree.
export const TOOL_OUTCOME_MAX_CHARS = 60;

// A tool-result entry carries its message as the first model message
// (pi-durable's EntryRecord) or as a plain `message` (the coarse lane cell
// shape); accept both so one helper serves the tree and the transcript.
function toolResultMessage(
  entry: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(entry)) return undefined;
  const model = entry.model;
  if (Array.isArray(model) && isRecord(model[0])) return model[0];
  return isRecord(entry.message) ? entry.message : undefined;
}

function toolResultText(entry: unknown): string | undefined {
  const message = toolResultMessage(entry);
  if (message === undefined || message.role !== ROLE_TOOL_RESULT) {
    return undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const parts = (message.content as unknown[])
    .map(textOf)
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join('\n');
}

// `Tests  17 passed (17)`, `Tests: 3 passed, 1 failed`, `ok 12 passed` — the
// first line carrying a count is the summary the operator wants.
function testSummaryOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const passed = /\b(\d+)\s+passed\b/iu.exec(line)?.[1];
    const failed = /\b(\d+)\s+failed\b/iu.exec(line)?.[1];
    if (passed === undefined && failed === undefined) continue;
    const parts: string[] = [];
    if (passed !== undefined) parts.push(`${passed} passed`);
    if (failed !== undefined) parts.push(`${failed} failed`);
    return parts.join(', ');
  }
  return undefined;
}

// The pi-durable bash text opens with `[bash exit N (shell)]`; the older
// JSON shell record is unpacked to a trailing `exit N` line.
const BASH_EXIT_HEAD = /\[bash exit (\d+)\b/u;
const JSON_EXIT_LINE = /^exit (\d+)$/mu;

export function summarizeToolOutcome(entry: unknown): string | undefined {
  const text = toolResultText(entry);
  if (text === undefined) return undefined;
  const body = unpackShellRecord(text);
  const summary = testSummaryOf(body);
  if (summary !== undefined) return boundOutcome(summary);
  const exit = BASH_EXIT_HEAD.exec(text)?.[1] ?? JSON_EXIT_LINE.exec(body)?.[1];
  // Exit 0 is the unremarkable case: the row stays short, only a failure
  // (or a test summary) earns an outcome.
  if (exit === undefined || exit === '0') return undefined;
  return `exit ${exit}`;
}

function boundOutcome(text: string): string {
  const oneLine = sanitizeLaneText(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TOOL_OUTCOME_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TOOL_OUTCOME_MAX_CHARS - 1)}…`;
}

// Shell tools return a JSON record ({stdout, stderr, exitCode, …}); showing
// the raw JSON buries the output in escapes. The record is unpacked into
// what a terminal would have shown, plus a non-zero exit code.
function unpackShellRecord(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (!isRecord(parsed)) return text;
  const stdout = parsed.stdout;
  const stderr = parsed.stderr;
  if (typeof stdout !== 'string' && typeof stderr !== 'string') return text;
  const lines: string[] = [];
  if (typeof stdout === 'string' && stdout.trim() !== '') {
    lines.push(stdout.replace(/\n+$/, ''));
  }
  if (typeof stderr === 'string' && stderr.trim() !== '') {
    lines.push(stderr.replace(/\n+$/, ''));
  }
  const code = parsed.exitCode;
  if (typeof code === 'number' && code !== 0) lines.push(`exit ${code}`);
  if (parsed.timedOut === true) lines.push('timed out');
  if (lines.length === 0) return '(no output)';
  return lines.join('\n');
}

function truncate(text: string): string {
  const clean = sanitizeLaneText(unpackShellRecord(text))
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
  let bounded = clean;
  const lines = bounded.split('\n');
  if (lines.length > TOOL_RESULT_MAX_LINES) {
    bounded = `${lines.slice(0, TOOL_RESULT_MAX_LINES).join('\n')}\n…`;
  }
  if (bounded.length <= TOOL_RESULT_MAX_CHARS) return bounded;
  return `${bounded.slice(0, TOOL_RESULT_MAX_CHARS - 1)}…`;
}

// Lane text is untrusted terminal input (issue #88, reviewer finding 1):
// assistant text and tool output can contain ESC-prefixed control sequences
// ('\x1b[2J' clears the screen, '\x1b[31m' repaints colour, '\x1b[<n>A'
// moves the cursor over the status bar) and C0 controls like BEL. Passing
// them through verbatim lets a model or a tool drive the operator's
// terminal. Everything except tab/newline is dropped; the renderer's own
// styling is untouched because only CONTENT is sanitized here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_SEQUENCES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeLaneText(text: string): string {
  return expandTabs(text.replace(CONTROL_SEQUENCES, ''));
}

// Tabs are expanded to 8-column stops so width math and truncation count
// the columns a terminal would actually draw.
export const TAB_STOP = 8;

function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      for (const ch of line) {
        if (ch === '\t') {
          out += ' '.repeat(TAB_STOP - (out.length % TAB_STOP));
        } else {
          out += ch;
        }
      }
      return out;
    })
    .join('\n');
}

function cellsForEntry(entry: LaneEntryLike): TranscriptEntry[] {
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (id === '') return [];
  if (entry.type !== 'message') return [];
  if (!isRecord(entry.message)) return [];
  const role = entry.message.role;
  if (!Array.isArray(entry.message.content)) return [];
  const parts = entry.message.content as unknown[];
  const cells: TranscriptEntry[] = [];
  const push = (
    key: string,
    kind: TranscriptEntryKind,
    markdown: string,
    extra: Partial<
      Pick<TranscriptEntry, 'detail' | 'isError' | 'toolCallId'>
    > = {},
  ): void => {
    if (markdown === '') return;
    cells.push({ id: `${id}:${key}`, kind, markdown, ...extra });
  };
  if (role === ROLE_USER) {
    const text = parts
      .map(textOf)
      .filter((t) => t !== undefined)
      .map((t) => sanitizeLaneText(t))
      .join('\n');
    push('user', 'prompt', text === '' ? '' : `${PROMPT_PREFIX}${text}`);
    return cells;
  }
  if (role === ROLE_TOOL_RESULT) {
    const text = parts
      .map(textOf)
      .filter((t) => t !== undefined)
      .map(truncate)
      .filter((t) => t !== '')
      .join('\n');
    const message = entry.message;
    const extra: { isError?: boolean; toolCallId?: string } = {};
    if (message.isError === true) extra.isError = true;
    if (typeof message.toolCallId === 'string' && message.toolCallId !== '') {
      extra.toolCallId = message.toolCallId;
    }
    push(
      'result',
      'output',
      text === '' && extra.toolCallId !== undefined ? '(no output)' : text,
      extra,
    );
    return cells;
  }
  if (role === ROLE_ASSISTANT) {
    parts.forEach((part, index) => {
      const text = textOf(part);
      if (text !== undefined) {
        push(
          `text${index === 0 ? '' : `:${index}`}`,
          'text',
          sanitizeLaneText(text).trim(),
        );
        return;
      }
      const name = nameOf(part);
      if (name !== undefined) {
        // The tool NAME is untrusted too: it comes from the model's tool
        // call, so it can carry the same control sequences as the text
        // (reviewer finding, second pass — a name of `evil\x1b[2Jname`
        // rendered the clear-screen sequence into the frame).
        const callId = toolCallIdOf(part, index);
        const detail = summarizeToolArguments(argumentsOf(part));
        push(callId, 'tool', `${TOOL_CALL_PREFIX}${sanitizeLaneText(name)}`, {
          ...(detail === '' ? {} : { detail }),
          ...(isRecord(part) && typeof part.id === 'string' && part.id !== ''
            ? { toolCallId: part.id }
            : {}),
        });
      }
    });
    return cells;
  }
  return cells;
}

export function entriesToCells(
  entries: ReadonlyArray<LaneEntryLike>,
): TranscriptEntry[] {
  const ordered = [...entries].sort((left, right) => {
    const a = typeof left.seq === 'number' ? left.seq : 0;
    const b = typeof right.seq === 'number' ? right.seq : 0;
    return a - b;
  });
  const cells: TranscriptEntry[] = [];
  for (const entry of ordered) {
    for (const cell of cellsForEntry(entry)) cells.push(cell);
  }
  return cells;
}
