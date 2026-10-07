// Grep operation.
// Regex search over walked files with line numbers and a match cap.
// replay:"safe" — searching has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';
import {
  WALK_MAX_DEPTH,
  WALK_MAX_ENTRIES,
  walkCapNotice,
  walkDepthNotice,
  walkFiles,
} from './walk.js';

export const GREP_DEFAULT_MAX = 100;

// / Pi's GREP_MAX_LINE_LENGTH: a matching line is clipped at this many
// characters and the result says so (`linesTruncated`) instead of flooding
// the context with one minified line. The line NUMBER still points at the
// real line; only the text is partial.
export const GREP_MAX_LINE_LENGTH = 500;

// Files above this are never searched: the same 8 MiB text
// bound read and edit share (READ_MAX_BYTES / EDIT_MAX_BYTES), so a file the
// read tool can show is a file grep can search. The file costs one stat and
// is never opened.
export const GREP_MAX_FILE_BYTES = 8 * 1024 * 1024;

// Total result budget: the rendered `path:line: text` lines
// together stay at or below this, matching read's output cap
// (READ_RESULT_MAX_BYTES) and Pi's DEFAULT_MAX_BYTES. The search stops at
// the last whole line that fits and names the cap.
export const GREP_RESULT_MAX_BYTES = 51200;

/** A NUL byte in the decoded content is grep's binary rule. */
const NUL = '\u0000';

export interface GrepArgs {
  pattern: string;
  root?: string;
  include?: string;
  maxMatches?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  pattern: string;
  matches: GrepMatch[];
  truncated: boolean;
  /**
   * At least one matching line was clipped at `GREP_MAX_LINE_LENGTH`. Optional
   * so an older/partial result stays valid.
   */
  linesTruncated?: boolean;
  /** Files not searched because they contain a NUL byte. */
  skippedBinary?: number;
  /** Files not searched because they are over `GREP_MAX_FILE_BYTES`. */
  skippedOversized?: number;
  /** Present when a cap (walk, maxMatches, result bytes or size) stopped the search. */
  notice?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateGrepArgs(raw: unknown): GrepArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'grep args must be an object');
  for (const key of Object.keys(raw)) {
    if (
      key !== 'pattern' &&
      key !== 'root' &&
      key !== 'include' &&
      key !== 'maxMatches'
    ) {
      throw new OpError(
        'invalid_args',
        `grep: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
    throw new OpError(
      'invalid_args',
      'grep: pattern must be a non-empty string',
    );
  }
  try {
    new RegExp(raw.pattern);
  } catch {
    throw new OpError('invalid_args', `grep: invalid regex: ${raw.pattern}`);
  }
  if (
    raw.root !== undefined &&
    (typeof raw.root !== 'string' || raw.root.length === 0)
  ) {
    throw new OpError('invalid_args', 'grep: root must be a non-empty string');
  }
  if (raw.include !== undefined && typeof raw.include !== 'string') {
    throw new OpError('invalid_args', 'grep: include must be a string');
  }
  if (
    raw.maxMatches !== undefined &&
    (!Number.isInteger(raw.maxMatches) || (raw.maxMatches as number) < 1)
  ) {
    throw new OpError(
      'invalid_args',
      'grep: maxMatches must be a positive integer',
    );
  }
  return {
    pattern: raw.pattern,
    root: raw.root as string | undefined,
    include: raw.include as string | undefined,
    maxMatches: raw.maxMatches as number | undefined,
  };
}

export const grepOperation: Operation<GrepArgs, GrepResult> = {
  name: 'grep',
  // Walk rules and caps, the line clip and the file
  // skips are part of what the model must know: a silent skip
  // or a silent cut reads as "no such file / no more matches".
  description: `Search file contents line by line with a JavaScript regex. Returns "path:line: text" lines under a header, at most maxMatches (default 100); matching lines are clipped at ${GREP_MAX_LINE_LENGTH} characters (the header says so when they are). include keeps only files whose path contains that substring (not a glob). Binary files (a NUL byte) are skipped and counted; files over ${GREP_MAX_FILE_BYTES} bytes are skipped and counted, and the result is then truncated. The search skips .git, node_modules and paths a .gitignore excludes, and never follows symlinks; it walks at most ${WALK_MAX_ENTRIES} entries and ${WALK_MAX_DEPTH} directory levels, and when a cap stops it the header names which one.`,
  replay: 'safe',
  validateArgs: validateGrepArgs,
  execute: async (_inv: ToolInvocation, args: GrepArgs, ctx: OpContext) => {
    const re = new RegExp(args.pattern);
    const root = args.root ?? '.';
    const max = args.maxMatches ?? GREP_DEFAULT_MAX;
    const matches: GrepMatch[] = [];
    const walk = walkFiles(ctx.env.fs, root);
    // The walk's own caps truncate the result whatever the match cap does.
    let truncated = walk.hitCap || walk.hitDepth;
    let notice = walk.hitCap
      ? walkCapNotice(walk.capAt)
      : walk.hitDepth
        ? walkDepthNotice(walk.depthAt)
        : undefined;
    // A match beyond `max` was actually seen (not merely a window that ended
    // exactly at the cap) — the one condition under which `truncated` is
    // exact rather than conservative.
    let overCap = false;
    let hitBytes = false;
    let linesTruncated = false;
    let skippedBinary = 0;
    let skippedOversized = 0;
    let resultBytes = 0;
    for (const entry of walk.entries) {
      if (entry.isDirectory) continue;
      if (args.include && !entry.path.includes(args.include)) continue;
      // Size first: an oversized file costs one stat and is
      // never opened, so grep's memory is bounded by the text bound, not by
      // the largest file in the tree. A file that vanished since the walk
      // (or cannot be stat'ed) is skipped silently, as before; an entry that
      // is not a regular file (a FIFO, socket or device — the walk lists
      // them) is skipped too: reading a FIFO could block the whole run, and
      // it is not a text-search candidate.
      let size: number;
      try {
        const info = ctx.env.fs.stat(entry.path);
        if (!info.isFile) continue;
        size = info.size;
      } catch {
        continue;
      }
      if (size > GREP_MAX_FILE_BYTES) {
        skippedOversized += 1;
        continue;
      }
      let text: string;
      try {
        text = ctx.env.fs.readFile(entry.path);
      } catch {
        continue;
      }
      // A NUL byte anywhere in the decoded content means binary (the rule).
      // read's sniff is deliberately BROADER — it also refuses a first chunk
      // that is not valid UTF-8 — and grep does not pay a second read for that:
      // a NUL-free invalid-UTF-8 file is still searched, which the tools page
      // states. The tool's contract is that binaries are never matched —
      // documented, and counted in the result — so this alone does not call the
      // search truncated.
      if (text.includes(NUL)) {
        skippedBinary += 1;
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] as string;
        if (!re.test(line)) continue;
        if (matches.length >= max) {
          overCap = true;
          break;
        }
        // Clip the TEXT, never the match — the line number stays
        // exact and `linesTruncated` says the text is partial.
        const clipped =
          line.length > GREP_MAX_LINE_LENGTH
            ? line.slice(0, GREP_MAX_LINE_LENGTH)
            : line;
        if (clipped.length !== line.length) linesTruncated = true;
        const rendered = `${entry.path}:${i + 1}: ${clipped}\n`;
        const bytes = Buffer.byteLength(rendered, 'utf8');
        if (resultBytes + bytes > GREP_RESULT_MAX_BYTES) {
          hitBytes = true;
          break;
        }
        resultBytes += bytes;
        matches.push({ path: entry.path, line: i + 1, text: clipped });
      }
      if (overCap || hitBytes) break;
      // When the walk itself already cut the result, stop scanning for a
      // match beyond the cap: the result is incomplete either way, and the
      // notice already says so. Without a walk cut, the scan continues only
      // until it can PROVE another match exists (or exhausts the walk), so
      // `truncated` never over-claims on a cap-exact match set.
      if (truncated && matches.length >= max) break;
    }
    if (overCap) {
      truncated = true;
      notice ??= `result cap ${max} reached (maxMatches); results may be incomplete`;
    }
    if (hitBytes) {
      truncated = true;
      notice ??= `output cap ${GREP_RESULT_MAX_BYTES}B reached; results may be incomplete`;
    }
    // An oversized file is a text candidate that was NOT searched, so the
    // result is partial and says so. A binary skip is the documented
    // contract instead — counted, not "truncated".
    if (skippedOversized > 0) {
      truncated = true;
      notice ??= `skipped ${skippedOversized} file(s) over the ${GREP_MAX_FILE_BYTES}B grep bound; results may be incomplete`;
    }
    return {
      pattern: args.pattern,
      matches,
      truncated,
      linesTruncated,
      skippedBinary,
      skippedOversized,
      notice,
    };
  },
};
