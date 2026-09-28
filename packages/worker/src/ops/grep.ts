// Grep operation (issue #13, slice B; §9.1).
// Regex search over walked files with line numbers and a match cap.
// replay:"safe" — searching has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';
import { walkCapNotice, walkFiles } from './walk.js';

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
  description: 'Search file contents for a regex with line numbers',
  replay: 'safe',
  validateArgs: validateGrepArgs,
  execute: async (_inv: ToolInvocation, args: GrepArgs, ctx: OpContext) => {
    const re = new RegExp(args.pattern);
    const root = args.root ?? '.';
    const max = args.maxMatches ?? GREP_DEFAULT_MAX;
    const matches: GrepMatch[] = [];
    const walk = walkFiles(ctx.env.fs, root);
    let truncated = walk.hitCap;
    let notice = walk.hitCap ? walkCapNotice(walk.capAt) : undefined;
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
        if (matches.length >= max) break;
        matches.push({
          path: entry.path,
          line: i + 1,
          text: lines[i] as string,
        });
      }
      // The match cap stopped the scan before the tree was exhausted, so the
      // result says so and names the bound (#172) — even when the cap was
      // reached on the very last line, "stopped at the bound" is the honest
      // reading (the same one `read` uses for a bound-stopped scan).
      if (matches.length >= max) {
        truncated = true;
        notice ??= `result cap ${max} reached (maxMatches); results may be incomplete`;
        break;
      }
    }
    return { pattern: args.pattern, matches, truncated, notice };
  },
};
