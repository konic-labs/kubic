// Read operation (issue #13, slice A; §9.1).
// Thin over ExecutionEnv.fs: path confinement comes from the seam.
// replay:"safe" — reading has no side effects.

import { StringDecoder } from 'node:string_decoder';
import type { FileSystem } from '../../../exec/src/env.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export const READ_MAX_LINES = 2000;

// Read bounds (issue #122): windowed reads pull the file through the seam
// in READ_CHUNK_BYTES chunks and never more than READ_MAX_BYTES total —
// the window costs the window, not the file. The seek phase is I/O
// proportional to the offset (honest, bounded); a byte-offset index is
// declined. Whenever the scan stops before EOF the flag says so —
// `truncated` derives from scan completeness (did the scan see EOF?), not
// from comparing the possibly-low totalLines against a cap.
export const READ_CHUNK_BYTES = 512 * 1024;
export const READ_MAX_BYTES = 8 * 1024 * 1024;

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  offset: number;
  // Exact when `truncated` is false. When `truncated` is true because the
  // scan stopped early, only a lower bound ("lines confirmed so far").
  totalLines: number;
  // Honesty contract: false guarantees totalLines is exact AND content is
  // complete for the requested region. True whenever the scan stopped
  // before EOF (totalLines is then a lower bound) or the output window cut
  // lines from the requested region.
  truncated: boolean;
}

// What readWindowed returns: the file's text from the start of line
// `offset` (the window's region) plus bookkeeping execute() cannot recover
// from a bounded scan.
export interface ReadWindow {
  text: string;
  // Exact when the scan reached EOF; when the scan stopped early this is
  // only a lower bound — a line whose start was scanned counts even if it
  // extends past the stop ("lines confirmed so far").
  totalLines: number;
  // True when the scan saw EOF (a short or empty range read). False means
  // the scan stopped early — READ_MAX_BYTES budget, line cap, or
  // limit-stopped region collection — and totalLines is then a lower bound.
  sawEof: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateReadArgs(raw: unknown): ReadArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'read args must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'path' && key !== 'offset' && key !== 'limit') {
      throw new OpError(
        'invalid_args',
        `read: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new OpError('invalid_args', 'read: path must be a non-empty string');
  }
  if (
    raw.offset !== undefined &&
    (!Number.isInteger(raw.offset) || (raw.offset as number) < 1)
  ) {
    throw new OpError(
      'invalid_args',
      'read: offset must be a 1-indexed integer',
    );
  }
  if (
    raw.limit !== undefined &&
    (!Number.isInteger(raw.limit) || (raw.limit as number) < 1)
  ) {
    throw new OpError('invalid_args', 'read: limit must be a positive integer');
  }
  return {
    path: raw.path,
    offset: raw.offset as number | undefined,
    limit: raw.limit as number | undefined,
  };
}

// A trailing newline does not start a new line.
function countLines(text: string): number {
  const lines = text.split('\n');
  return lines.length > 0 && lines[lines.length - 1] === ''
    ? lines.length - 1
    : lines.length;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

// Bounded windowing (issue #122): chunked newline-counting seek to the
// `offset` line, then collect until `limit` lines are in hand — one
// StringDecoder across chunks so multi-byte codepoints split at a chunk
// boundary survive. Fallback: seams without readFileRange (test doubles,
// older bridges) get a whole read — correct but unbounded — windowed by the
// same slice as always.
export function readWindowed(
  fs: FileSystem,
  path: string,
  offset: number,
  limit: number,
): ReadWindow {
  const range = fs.readFileRange;
  if (range === undefined) {
    const text = fs.readFile(path);
    return {
      text: text
        .split('\n')
        .slice(offset - 1)
        .join('\n'),
      totalLines: countLines(text),
      sawEof: true,
    };
  }
  const want = offset - 1; // newlines to consume before the region starts
  const decoder = new StringDecoder('utf8');
  let at = 0; // next unread byte
  let scanned = 0; // total bytes pulled through the seam (the budget)
  let seeked = 0; // newlines seen before the current chunk
  let region: string | undefined;
  let regionNewlines = 0;
  let endNewline = false; // did the decoded text end on '\n'?
  let sawEof = false;
  for (;;) {
    if (region !== undefined && regionNewlines >= limit) break;
    if (scanned >= READ_MAX_BYTES) {
      break;
    }
    const request = Math.min(READ_CHUNK_BYTES, READ_MAX_BYTES - scanned);
    const chunk = range(path, at, at + request);
    if (chunk.length === 0) {
      sawEof = true;
      break;
    }
    scanned += chunk.length;
    at += chunk.length;
    const text = decoder.write(chunk);
    if (text.length > 0) endNewline = text.endsWith('\n');
    if (region === undefined) {
      const chunkNewlines = countNewlines(text);
      if (seeked + chunkNewlines >= want) {
        // The region starts inside this chunk: skip the (want - seeked)th
        // newline and keep the remainder.
        let idx = 0;
        for (let i = seeked; i < want; i += 1) {
          idx = text.indexOf('\n', idx) + 1;
        }
        region = text.slice(idx);
        regionNewlines = countNewlines(region);
      }
      seeked += chunkNewlines;
    } else {
      region += text;
      regionNewlines += countNewlines(text);
    }
    if (chunk.length < request) {
      sawEof = true;
      break;
    }
  }
  if (region === undefined && sawEof) {
    // Offset past EOF: the whole (possibly empty) file was scanned.
    return {
      text: '',
      totalLines: scanned === 0 ? 0 : seeked + (endNewline ? 0 : 1),
      sawEof: true,
    };
  }
  if (region === undefined) {
    // Budget spent before the offset line: its window is unreachable. A
    // line that started within the scanned bytes counts; one that never
    // started (the scan ended on a newline) does not.
    return {
      text: '',
      totalLines: seeked + (endNewline ? 0 : 1),
      sawEof: false,
    };
  }
  let text = region;
  let startedPartial = 0;
  if (sawEof) {
    text += decoder.end();
  } else if (text.length > 0 && !text.endsWith('\n')) {
    // Never hand the window a partial line outside the EOF case — but the
    // line STARTED within the scanned bytes, so it counts toward
    // totalLines even though it extends past the stop.
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    startedPartial = 1;
  }
  return {
    text,
    totalLines: want + countLines(text) + startedPartial,
    sawEof,
  };
}

export const readOperation: Operation<ReadArgs, ReadResult> = {
  name: 'read',
  description: 'Read file contents with line offset/limit',
  replay: 'safe',
  validateArgs: validateReadArgs,
  execute: async (_inv: ToolInvocation, args: ReadArgs, ctx: OpContext) => {
    const offset = args.offset ?? 1;
    const span = args.limit ?? READ_MAX_LINES;
    let view: ReadWindow;
    try {
      view = readWindowed(ctx.env.fs, args.path, offset, span);
    } catch {
      throw new OpError('not_found', `read: no such file: ${args.path}`);
    }
    const lines = view.text.split('\n');
    // A trailing '\n' ends the last line; it does not start an empty one.
    if (lines[lines.length - 1] === '') lines.pop();
    const window = lines.slice(0, span);
    const body = window.slice(0, READ_MAX_LINES).join('\n');
    // truncated is honest (issue #122): true whenever the scan stopped
    // before EOF — totalLines is then only a lower bound — or the output
    // window cut lines from the requested region. The totalLines
    // comparison only speaks when the scan reached EOF (the count is then
    // exact), never against a lower bound.
    const outputCut =
      (view.sawEof &&
        args.limit === undefined &&
        view.totalLines > READ_MAX_LINES) ||
      window.length > READ_MAX_LINES;
    return {
      path: args.path,
      // Empty only when the window holds no text at all: a lone blank line
      // is '\n', not an empty file.
      content: view.text.length > 0 ? `${body}\n` : '',
      offset,
      totalLines: view.totalLines,
      truncated: !view.sawEof || outputCut,
    };
  },
};
