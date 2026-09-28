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

// Model-facing output cap (issue #176; §27.5): READ_MAX_BYTES above bounds
// the SCAN; this bounds the RESULT — Pi's DEFAULT_MAX_BYTES (50 KiB), the
// byte twin of READ_MAX_LINES. One minified line or a few-hundred-KB file
// must cost the window, not the context. Whole lines only: a clipped line
// could poison an exact-match edit, so a line that alone exceeds the cap is
// left out and the notice names it with a bash continuation; otherwise the
// last kept line sets the `more: offset=` hint. Fields are only ADDED
// (#176) — nothing renamed, so existing consumers keep the same shape.
export const READ_RESULT_MAX_BYTES = 50 * 1024;

// Why the first chunk sniffed as binary (issue #176): a NUL codepoint (the
// file may still decode cleanly — UTF-16 text) or a UTF-8 validity failure
// (the PNG signature's 0x89 lead).
export type ReadBinaryReason = 'nul' | 'invalid_utf8';

export interface ReadBinaryRefusal {
  reason: ReadBinaryReason;
  // The file's size in bytes; absent when the seam cannot stat it (a race
  // against the read that already succeeded).
  bytes?: number;
}

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
  // Present when the window cannot be served plainly (issue #176): the
  // output cap left a line out, a binary file was refused, or the offset
  // is past the last line. One model-facing line; renderReadText places
  // it after the path.
  notice?: string;
  // The structured binary refusal behind a binary `notice` (issue #176):
  // why the sniff fired, and the file's size. Absent on text reads.
  binary?: ReadBinaryRefusal;
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
  // Set when the FIRST chunk sniffed as binary (issue #176). The sniff is
  // a mark, never a scan cut: the window contract above (#122) is
  // unchanged, and execute() turns the mark into the refusal.
  binary?: ReadBinaryReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

// First-chunk binary sniff (issue #176). Strict UTF-8 with stream
// semantics: a codepoint split at the chunk's end is buffered, not an
// error, so a multi-byte character straddling the 512 KiB boundary never
// reads as invalid. NUL is a VALID UTF-8 codepoint, so it needs its own
// pass — UTF-16 and other NUL-padded content decode cleanly otherwise.
function sniffBinaryBytes(chunk: Uint8Array): ReadBinaryReason | undefined {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(chunk, { stream: true });
  } catch {
    return 'invalid_utf8';
  }
  for (const byte of chunk) {
    if (byte === 0) return 'nul';
  }
  return undefined;
}

// Seams without readFileRange (test doubles, older bridges) hand back an
// already-decoded string; a U+FFFD is the only evidence left that the
// decode replaced bytes. Best-effort and fail-closed: refusing a rare
// literal U+FFFD beats dumping replacement-char garbage into context.
function sniffBinaryText(text: string): ReadBinaryReason | undefined {
  if (text.includes('\uFFFD')) return 'invalid_utf8';
  if (text.includes('\0')) return 'nul';
  return undefined;
}

// Single-quote a shell argument (issue #176): the notice suggests a bash
// command, and a path is attacker-influenced content — a name with spaces
// must not become two arguments, nor a `$(…)` name become a command.
function shellQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`;
}

// The output window under the byte cap (issue #176): whole lines only.
// `used` counts each kept line plus the '\n' that will follow it, so the
// assembled content (trailing newline included) never exceeds
// READ_RESULT_MAX_BYTES. The caller only calls this when the assembled
// content (body plus its trailing newline) would exceed the cap, so at
// least one line is always left out.
function clipOutputLines(
  lines: string[],
  path: string,
  offset: number,
): { lines: string[]; notice: string } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = utf8Bytes(line) + 1;
    if (used + size > READ_RESULT_MAX_BYTES) break;
    kept.push(line);
    used += size;
  }
  const first = lines[0];
  if (kept.length > 0 || first === undefined) {
    return {
      lines: kept,
      notice: `output clipped at ${READ_RESULT_MAX_BYTES}B`,
    };
  }
  // The path goes through stdin, never as a sed operand (issue #176 review):
  // GNU sed permutes options, so an operand named `-e1e touch pwned` (or
  // r/-f/w variants) would run as sed script text when the suggestion is
  // pasted into a shell.
  return {
    lines: kept,
    notice: `line ${offset} is ${utf8Bytes(first)}B — above the ${READ_RESULT_MAX_BYTES}B output cap; read it with bash: sed -n '${offset}p' < ${shellQuote(path)} | head -c ${READ_RESULT_MAX_BYTES}`,
  };
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
  // Called as a method, never extracted: the real NodeFileSystem reads
  // `this.cwd` (issue #199).
  if (fs.readFileRange === undefined) {
    const text = fs.readFile(path);
    const binary = sniffBinaryText(text);
    return {
      text: text
        .split('\n')
        .slice(offset - 1)
        .join('\n'),
      totalLines: countLines(text),
      sawEof: true,
      ...(binary === undefined ? {} : { binary }),
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
  let binary: ReadBinaryReason | undefined;
  for (;;) {
    if (region !== undefined && regionNewlines >= limit) break;
    if (scanned >= READ_MAX_BYTES) {
      break;
    }
    const request = Math.min(READ_CHUNK_BYTES, READ_MAX_BYTES - scanned);
    const chunk = fs.readFileRange(path, at, at + request);
    if (chunk.length === 0) {
      sawEof = true;
      break;
    }
    // The scan always starts at byte 0, so the first chunk is the file's
    // head however deep the requested offset is.
    if (at === 0) binary = sniffBinaryBytes(chunk);
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
      ...(binary === undefined ? {} : { binary }),
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
      ...(binary === undefined ? {} : { binary }),
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
    ...(binary === undefined ? {} : { binary }),
  };
}

// Name the real failure (issue #199): only a missing path is `not_found`.
// A directory or a permission refusal gets its own code, a cwd-confinement
// escape is the caller's argument, and anything else propagates unchanged
// so a regression surfaces as a fault instead of a phantom missing file.
export function readFailure(err: unknown, path: string): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new OpError('not_found', `read: no such file: ${path}`);
  }
  if (code === 'EISDIR') {
    return new OpError(
      'is_directory',
      `read: ${path} is a directory (use ls to list it)`,
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new OpError('permission_denied', `read: permission denied: ${path}`);
  }
  if (
    err instanceof Error &&
    err.message.startsWith('path escapes cwd confinement')
  ) {
    return new OpError('invalid_args', `read: ${err.message}`);
  }
  return err;
}

export const readOperation: Operation<ReadArgs, ReadResult> = {
  name: 'read',
  description:
    'Read a text file. Returns the raw lines under a "[read <path>: lines a-b of N]" header. offset is 1-indexed (default 1); limit defaults to and is capped at 2000 lines; at most 8 MiB is scanned and at most 51200 bytes are returned (long output arrives clipped, with a notice). Binary files are refused. When the header ends "more: offset=N", call again with that offset.',
  replay: 'safe',
  validateArgs: validateReadArgs,
  execute: async (_inv: ToolInvocation, args: ReadArgs, ctx: OpContext) => {
    const offset = args.offset ?? 1;
    const span = args.limit ?? READ_MAX_LINES;
    let view: ReadWindow;
    try {
      view = readWindowed(ctx.env.fs, args.path, offset, span);
    } catch (err) {
      throw readFailure(err, args.path);
    }
    if (view.binary !== undefined) {
      // Structured refusal (issue #176): no bytes reach the content, and
      // the size comes from stat — the sniff chunk is not the file.
      let bytes: number | undefined;
      try {
        bytes = ctx.env.fs.stat(args.path).size;
      } catch {
        bytes = undefined;
      }
      const size = bytes === undefined ? '' : `${bytes}B, `;
      const type = view.binary === 'nul' ? 'NUL bytes' : 'invalid UTF-8';
      return {
        path: args.path,
        content: '',
        offset,
        totalLines: view.totalLines,
        // The requested bytes are not what reached the model.
        truncated: true,
        binary: {
          reason: view.binary,
          ...(bytes === undefined ? {} : { bytes }),
        },
        notice: `binary file (${size}${type}) — read serves text only; use bash for byte-level inspection`,
      };
    }
    const lines = view.text.split('\n');
    // A trailing '\n' ends the last line; it does not start an empty one.
    if (lines[lines.length - 1] === '') lines.pop();
    const window = lines.slice(0, span);
    let body = window.slice(0, READ_MAX_LINES).join('\n');
    let notice: string | undefined;
    let byteClipped = false;
    let emptiedByClip = false;
    // The cap bounds the CONTENT, which is body plus its trailing '\n'.
    if (utf8Bytes(body) + 1 > READ_RESULT_MAX_BYTES) {
      const clipped = clipOutputLines(
        window.slice(0, READ_MAX_LINES),
        args.path,
        offset,
      );
      byteClipped = true;
      notice = clipped.notice;
      body = clipped.lines.join('\n');
      // A line left out whole (`kept === 0`) leaves no window text: an
      // empty body plus '\n' would fake a blank line.
      emptiedByClip = clipped.lines.length === 0;
      if (emptiedByClip && offset < view.totalLines) {
        // The line at the offset is too large to carry, but the file has
        // further lines: name where a read CAN continue. When `offset`
        // equals a lower-bound totalLines the next line may not exist yet,
        // so the hint only speaks when the count confirms it.
        notice += `; more: offset=${offset + 1}`;
      }
    }
    if (
      notice === undefined &&
      view.sawEof &&
      view.totalLines > 0 &&
      offset > view.totalLines
    ) {
      // The scan reached EOF, so totalLines is exact and the offset is
      // provably past the last line (issue #176). When the budget stopped
      // the scan instead, the offset is only past the CONFIRMED lines and
      // the header's "no lines at offset K (file has at least N lines)"
      // stays honest — no notice.
      const total = view.totalLines === 1 ? 'line' : 'lines';
      notice = `offset ${offset} is past the last line (${view.totalLines} ${total} total)`;
    }
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
      // is '\n', not an empty file. A byte-clipped-away line is the other
      // empty case — the notice names it.
      content: view.text.length > 0 && !emptiedByClip ? `${body}\n` : '',
      offset,
      totalLines: view.totalLines,
      truncated: !view.sawEof || outputCut || byteClipped,
      ...(notice === undefined ? {} : { notice }),
    };
  },
};
