// Read operation (issue #13, slice A; §9.1).
// Thin over ExecutionEnv.fs: path confinement comes from the seam.
// replay:"safe" — reading has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export const READ_MAX_LINES = 2000;

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  offset: number;
  totalLines: number;
  truncated: boolean;
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

export const readOperation: Operation<ReadArgs, ReadResult> = {
  name: 'read',
  description: 'Read file contents with line offset/limit',
  replay: 'safe',
  validateArgs: validateReadArgs,
  execute: async (_inv: ToolInvocation, args: ReadArgs, ctx: OpContext) => {
    let text: string;
    try {
      text = ctx.env.fs.readFile(args.path);
    } catch {
      throw new OpError('not_found', `read: no such file: ${args.path}`);
    }
    const lines = text.split('\n');
    // A trailing newline does not start a new line.
    const totalLines =
      lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
    const offset = args.offset ?? 1;
    const window = lines.slice(
      offset - 1,
      offset - 1 + (args.limit ?? READ_MAX_LINES),
    );
    const capped = args.limit === undefined && totalLines > READ_MAX_LINES;
    const body = window.slice(0, READ_MAX_LINES).join('\n');
    return {
      path: args.path,
      content: body.length > 0 ? `${body}\n` : '',
      offset,
      totalLines,
      truncated: capped || window.length > READ_MAX_LINES,
    };
  },
};
