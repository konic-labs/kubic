// Grep operation (issue #13, slice B; §9.1).
// Regex search over walked files with line numbers and a match cap.
// replay:"safe" — searching has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';
import { walkCapNotice, walkDepthNotice, walkFiles } from './walk.js';

export const GREP_DEFAULT_MAX = 100;

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
  /** Present when a cap (walk or maxMatches) stopped the search. */
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
  description:
    'Search file contents line by line with a JavaScript regex. Returns "path:line: text" lines under a header, at most maxMatches (default 100). include keeps only files whose path contains that substring (not a glob).',
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
    for (const entry of walk.entries) {
      if (entry.isDirectory) continue;
      if (args.include && !entry.path.includes(args.include)) continue;
      let text: string;
      try {
        text = ctx.env.fs.readFile(entry.path);
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i] as string)) continue;
        if (matches.length >= max) {
          overCap = true;
          break;
        }
        matches.push({
          path: entry.path,
          line: i + 1,
          text: lines[i] as string,
        });
      }
      if (overCap) break;
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
    return { pattern: args.pattern, matches, truncated, notice };
  },
};
