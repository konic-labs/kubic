// Write operation (issue #13, slice C; §9.1).
// Atomic via tmp+rename over the seam: readers never see a partial file.
// replay:"never" — writes are effects, never re-executed on replay.

import { sha256Hex } from './hash.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface WriteArgs {
  path: string;
  content: string;
}

export interface WriteResult {
  path: string;
  beforeHash: string | null;
  afterHash: string;
  bytesDelta: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateWriteArgs(raw: unknown): WriteArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'write args must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'path' && key !== 'content') {
      throw new OpError(
        'invalid_args',
        `write: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new OpError('invalid_args', 'write: path must be a non-empty string');
  }
  if (typeof raw.content !== 'string') {
    throw new OpError('invalid_args', 'write: content must be a string');
  }
  return { path: raw.path, content: raw.content };
}

export const writeOperation: Operation<WriteArgs, WriteResult> = {
  name: 'write',
  description: 'Write a file atomically (tmp + rename) with hashes',
  replay: 'never',
  validateArgs: validateWriteArgs,
  execute: async (_inv: ToolInvocation, args: WriteArgs, ctx: OpContext) => {
    let beforeHash: string | null = null;
    let beforeBytes = 0;
    try {
      const prev = ctx.env.fs.readFile(args.path);
      beforeHash = sha256Hex(prev);
      beforeBytes = Buffer.byteLength(prev, 'utf8');
    } catch {
      beforeHash = null;
    }
    const tmp = `${args.path}.kubic-tmp`;
    ctx.env.fs.writeFile(tmp, args.content);
    ctx.env.fs.rename(tmp, args.path);
    return {
      path: args.path,
      beforeHash,
      afterHash: sha256Hex(args.content),
      bytesDelta: Buffer.byteLength(args.content, 'utf8') - beforeBytes,
    };
  },
};
