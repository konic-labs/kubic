// Coarse lane-entry cells for the transcript.
// Replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; routes no message
// events, so the transcript is built from the lane's own entries). Pure:
// entries in, cells out, no I/O.
//
// The lane hands entries back newest-first (Pi scans the branch from the
// tip), so cells are ordered by `seq` ascending — the transcript reads
// top-to-bottom as the session happened. Every cell id is derived from the
// entry id plus the part index, so a re-render replaces cells instead of
// duplicating them.

import type { LaneImagePart } from '@kubic/core/presentation';
import { imagePartOf } from './attachments.js';
import type {
  CellDisplay,
  TranscriptEntry,
  TranscriptEntryKind,
} from './transcript.js';
import { visibleWidth } from './tui-boundary.js';

// Entry shapes are structural on purpose: the tui package must never import
// agent/host implementation (dep-lint), so only the fields read here are
// typed.
export interface LaneEntryLike {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
  // A `compaction` cell carries why it happened (auto / manual /
  // overflow), rendered beside the marker.
  readonly reason?: unknown;
}

// Upper bound on the output a cell carries (the view collapses it further
// to TOOL_OUTPUT_PREVIEW_LINES unless the operator expands it with Ctrl-X).
/** @internal */
export const TOOL_RESULT_MAX_CHARS = 20_000;
const TOOL_RESULT_MAX_LINES = 400;
/** @internal */
export const TOOL_DETAIL_MAX_CHARS = 120;

const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';
const ROLE_TOOL_RESULT = 'toolResult';

export const PROMPT_PREFIX = '› ';
const TOOL_CALL_PREFIX = 'tool ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textOf(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type !== 'text') return undefined;
  return typeof part.text === 'string' ? part.text : undefined;
}

// A reasoning part (Pi ThinkingContent). A redacted one carries
// only an opaque signature, so it has nothing to show.
function thinkingOf(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== 'thinking') return undefined;
  if (part.redacted === true) return undefined;
  return typeof part.thinking === 'string' ? part.thinking : undefined;
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

// The one-line OUTCOME of a finished tool call: the test summary the operator
// reads first (`17 passed`), else a non-zero shell exit code. Only the shell
// tool has either — a `read` of a file whose text happens to contain `17
// passed` must not turn into a test report — so the caller names the tool and
// anything else yields no outcome. Both fields come from untrusted tool output,
// so the returned text is sanitized and newline-collapsed before it reaches the
// tree.
/** @internal */
export const TOOL_OUTCOME_MAX_CHARS = 60;

// The one shell tool Kubic registers (`packages/agent/src/ops/bash.ts`);
// exit codes and test summaries are its results' vocabulary.
const SHELL_TOOL_NAME = 'bash';

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

export function summarizeToolOutcome(
  entry: unknown,
  toolName?: string,
): string | undefined {
  if (toolName !== SHELL_TOOL_NAME) return undefined;
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

// Lane text is untrusted terminal input:
// assistant text and tool output can contain ESC-prefixed control sequences
// ('\x1b[2J' clears the screen, '\x1b[31m' repaints colour, '\x1b[<n>A'
// moves the cursor over the status bar) and C0 controls like BEL. Passing
// them through verbatim lets a model or a tool drive the operator's
// terminal.
//
// The complete ECMA-48 sequences are stripped, not just the ESC
// byte. A tool that colours its output without a TTY (FORCE_COLOR test
// runners, git color.ui=always, npm progress bars) emits real escapes, and
// deleting only the ESC left the parameter bytes behind as visible noise
// ('[31mred'). Order matters: OSC first (it may contain ESC and '['), then
// CSI (7-bit and the 8-bit C1 form), then the general ESC form, then
// whatever control bytes are left. The renderer's own styling is untouched
// because only CONTENT is sanitized here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const C1_CSI_SEQUENCE = /\u009b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;
// \t, \n and \r are excluded: tabs expand, newlines split, and \r is
// collapsed (not deleted) by the pass below.
const CONTROL_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeLaneText(text: string): string {
  return expandTabs(collapseCarriageReturns(stripControlSequences(text)));
}

// A progress bar redraws its line with `\r`: a terminal shows what came
// after the last return, so that is what the transcript shows (deleting the
// returns instead would glue the frames together). This runs AFTER the
// sequence sweep and before tabs, so no return reaches a frame.
function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      // A trailing return moves the cursor without overwriting anything:
      // the text before it is what the terminal shows.
      const written = line.replace(/\r+$/, '');
      return written.split('\r').pop() ?? '';
    })
    .join('\n');
}

function stripControlSequences(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(C1_CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_SEQUENCES, '');
}

// Tabs are expanded to 8-column stops so width math and truncation count
// the columns a terminal would actually draw. The stop is measured with
// `visibleWidth`: a CJK glyph occupies two columns, so
// counting UTF-16 units misaligned every line after it.
/** @internal */
export const TAB_STOP = 8;

function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      // Measure only the run since the LAST tab. A grapheme
      // cannot span a tab, so the running column stays exact while the pass
      // is O(line) — calling `visibleWidth` on the whole accumulated line
      // per tab made a tab-heavy line (a generated table, a `printf` run)
      // quadratic on the untrusted ingress path.
      let column = 0;
      let pending = '';
      for (const ch of line) {
        if (ch === '\t') {
          const run = visibleWidth(pending);
          const pad = TAB_STOP - ((column + run) % TAB_STOP);
          out += `${pending}${' '.repeat(pad)}`;
          column += run + pad;
          pending = '';
        } else {
          pending += ch;
        }
      }
      return out + pending;
    })
    .join('\n');
}

// pi-durable wraps a compaction summary in a fixed preamble and <summary>
// tags (`harness/compaction.js`'s SUMMARY_PREFIX/SUFFIX). The operator wants
// the summary itself, so the wrapper is dropped when it is present.
function compactionSummaryOf(text: string): string {
  return text
    .replace(
      /^The conversation history before this point was compacted into the following summary:\s*\n*/u,
      '',
    )
    .replace(/^<summary>\s*\n?/u, '')
    .replace(/\n?<\/summary>\s*$/u, '')
    .trim();
}

// The display record a file change put in the result's details.
// Its text is file content — untrusted like every other lane string — so
// each row is sanitized after its `+12 ` / `-12 ` / ` 12 ` prefix (tabs then
// expand from the content's own first column).
const DIFF_ROW = /^([-+ ] *\d+ )(.*)$/u;

function displayOf(details: unknown): CellDisplay | undefined {
  if (!isRecord(details) || !isRecord(details.display)) return undefined;
  const display = details.display;
  if (
    display.kind === 'diff' &&
    typeof display.text === 'string' &&
    typeof display.added === 'number' &&
    typeof display.removed === 'number'
  ) {
    const text = display.text
      .split('\n')
      .map((row) => {
        const hit = DIFF_ROW.exec(row);
        return hit === null
          ? sanitizeLaneText(row)
          : `${hit[1]}${sanitizeLaneText(hit[2] ?? '')}`;
      })
      .join('\n');
    return {
      kind: 'diff',
      text,
      firstChangedLine:
        typeof display.firstChangedLine === 'number'
          ? display.firstChangedLine
          : 1,
      added: display.added,
      removed: display.removed,
      truncated: display.truncated === true,
    };
  }
  if (
    display.kind === 'write' &&
    typeof display.lines === 'number' &&
    typeof display.preview === 'string'
  ) {
    return {
      kind: 'write',
      newFile: display.newFile === true,
      lines: display.lines,
      preview: sanitizeLaneText(display.preview),
    };
  }
  return undefined;
}

function cellsForEntry(entry: LaneEntryLike): TranscriptEntry[] {
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (id === '') return [];
  if (entry.type === 'compaction' || entry.type === 'reset') {
    // A compaction summary (and a reset handoff) is part of the
    // session's story — the transcript shows it instead of dropping it. The
    // text is untrusted like any other lane text, so it is sanitized here.
    if (!isRecord(entry.message)) return [];
    if (!Array.isArray(entry.message.content)) return [];
    const text = (entry.message.content as unknown[])
      .map(textOf)
      .filter((part): part is string => part !== undefined)
      .map(sanitizeLaneText)
      .join('\n')
      .trim();
    if (text === '') return [];
    const summary =
      entry.type === 'compaction' ? compactionSummaryOf(text) : text;
    const reason =
      typeof entry.reason === 'string' && entry.reason !== ''
        ? sanitizeLaneText(entry.reason)
        : undefined;
    return [
      {
        id: `${id}:${entry.type}`,
        kind: entry.type === 'compaction' ? 'compaction' : 'text',
        markdown: summary === '' ? text : summary,
        ...(reason === undefined ? {} : { detail: reason }),
      },
    ];
  }
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
      Pick<
        TranscriptEntry,
        'detail' | 'isError' | 'toolCallId' | 'images' | 'timestamp'
      >
    > = {},
  ): void => {
    if (markdown === '') return;
    cells.push({ id: `${id}:${key}`, kind, markdown, ...extra });
  };
  // Pi stamps every message; the prompt block shows the time.
  const stamp =
    typeof entry.message.timestamp === 'number' &&
    Number.isFinite(entry.message.timestamp)
      ? { timestamp: entry.message.timestamp }
      : {};
  if (role === ROLE_USER) {
    // An attached image is part of the prompt, not text. A
    // prompt cell with images and no text (an image-only submit) still
    // renders, so the attachment is never invisible.
    const images = parts
      .map(imagePartOf)
      .filter((part): part is LaneImagePart => part !== undefined);
    const text = parts
      .map(textOf)
      .filter((t) => t !== undefined)
      .map((t) => sanitizeLaneText(t))
      .join('\n');
    const hasImages = images.length > 0;
    push(
      'user',
      'prompt',
      text === ''
        ? hasImages
          ? PROMPT_PREFIX
          : ''
        : `${PROMPT_PREFIX}${text}`,
      { ...(hasImages ? { images } : {}), ...stamp },
    );
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
    const extra: {
      isError?: boolean;
      toolCallId?: string;
      display?: CellDisplay;
    } = {};
    if (message.isError === true) extra.isError = true;
    if (typeof message.toolCallId === 'string' && message.toolCallId !== '') {
      extra.toolCallId = message.toolCallId;
    }
    const display = displayOf(message.details);
    if (display !== undefined) extra.display = display;
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
      const thinking = thinkingOf(part);
      if (thinking !== undefined) {
        push(
          `thinking:${index}`,
          'thinking',
          sanitizeLaneText(thinking).trim(),
          stamp,
        );
        return;
      }
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
        // (a name of `evil\x1b[2Jname`
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

// The committed user prompts of a lane's entries, newest last —
// the text a resumed session's editor history is seeded with. A compaction
// summary (role user inside a `compaction` entry) and an image-only prompt
// are not prompts to recall.
export function userPromptsOf(entries: ReadonlyArray<LaneEntryLike>): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || !isRecord(entry.message)) continue;
    if (entry.message.role !== ROLE_USER) continue;
    if (!Array.isArray(entry.message.content)) continue;
    const text = (entry.message.content as unknown[])
      .map(textOf)
      .filter((t) => t !== undefined)
      .join('\n')
      .trim();
    if (text !== '') prompts.push(text);
  }
  return prompts;
}

// One fork point of the `/tree` picker — an earlier prompt
// (`entryId`) and the entry just before it (`at`), which is where the fork
// cuts so the operator can retry that prompt.
export interface ForkPoint {
  readonly entryId: number;
  readonly at: number;
  readonly text: string;
}

const FORK_LABEL_MAX = 60;

// The `/tree` picker rows: newest prompt first, the label is the entry id and
// a one-line preview (sanitized — prompt text came from the session file),
// and the value carries `at:entryId` for the fork.
export function forkPickerRows(
  points: ReadonlyArray<ForkPoint>,
): Array<{ value: string; label: string; description: string }> {
  return [...points]
    .sort((left, right) => right.entryId - left.entryId)
    .map((point) => {
      const oneLine = sanitizeLaneText(point.text).replace(/\s+/g, ' ').trim();
      const preview =
        [...oneLine].length > FORK_LABEL_MAX
          ? `${[...oneLine].slice(0, FORK_LABEL_MAX - 1).join('')}…`
          : oneLine;
      return {
        value: `${point.at}:${point.entryId}`,
        label: `#${point.entryId}  ${preview}`,
        description: `fork before this prompt (at #${point.at})`,
      };
    });
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
