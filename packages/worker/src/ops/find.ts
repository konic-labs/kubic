// Find operation (issue #13, slice B; §9.1).
// Recursive walk over the seam with substring/type filters and a result
// cap. replay:"safe" — searching has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';
import { walkCapNotice, walkDepthNotice, walkFiles } from './walk.js';

export const FIND_DEFAULT_MAX = 100;

export interface FindArgs {
  root?: string;
  nameContains?: string;
  type?: 'file' | 'dir';
  maxResults?: number;
}

export interface FindResult {
  root: string;
  paths: string[];
  truncated: boolean;
  /** Present when a cap (walk or maxResults) stopped the listing. */
  notice?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateFindArgs(raw: unknown): FindArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'find args must be an object');
  for (const key of Object.keys(raw)) {
    if (
      key !== 'root' &&
      key !== 'nameContains' &&
      key !== 'type' &&
      key !== 'maxResults'
    ) {
      throw new OpError(
        'invalid_args',
        `find: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (
    raw.root !== undefined &&
    (typeof raw.root !== 'string' || raw.root.length === 0)
  ) {
    throw new OpError('invalid_args', 'find: root must be a non-empty string');
  }
  if (raw.nameContains !== undefined && typeof raw.nameContains !== 'string') {
    throw new OpError('invalid_args', 'find: nameContains must be a string');
  }
  if (raw.type !== undefined && raw.type !== 'file' && raw.type !== 'dir') {
    throw new OpError('invalid_args', 'find: type must be "file" or "dir"');
  }
  if (
    raw.maxResults !== undefined &&
    (!Number.isInteger(raw.maxResults) || (raw.maxResults as number) < 1)
  ) {
    throw new OpError(
      'invalid_args',
      'find: maxResults must be a positive integer',
    );
  }
  return {
    root: raw.root as string | undefined,
    nameContains: raw.nameContains as string | undefined,
    type: raw.type as 'file' | 'dir' | undefined,
    maxResults: raw.maxResults as number | undefined,
  };
}

export const findOperation: Operation<FindArgs, FindResult> = {
  name: 'find',
  description: 'Find files and directories recursively with filters',
  replay: 'safe',
  validateArgs: validateFindArgs,
  execute: async (_inv: ToolInvocation, args: FindArgs, ctx: OpContext) => {
    const root = args.root ?? '.';
    const max = args.maxResults ?? FIND_DEFAULT_MAX;
    const walk = walkFiles(ctx.env.fs, root);
    const paths: string[] = [];
    let truncated = walk.hitCap || walk.hitDepth;
    let notice = walk.hitCap
      ? walkCapNotice(walk.capAt)
      : walk.hitDepth
        ? walkDepthNotice(walk.depthAt)
        : undefined;
    for (const entry of walk.entries) {
      if (args.type === 'file' && entry.isDirectory) continue;
      if (args.type === 'dir' && !entry.isDirectory) continue;
      if (
        args.nameContains &&
        !entry.path.split('/').pop()?.includes(args.nameContains)
      )
        continue;
      if (paths.length >= max) {
        truncated = true;
        notice ??= `result cap ${max} reached (maxResults); results may be incomplete`;
        break;
      }
      paths.push(entry.path);
    }
    return { root, paths, truncated, notice };
  },
};
