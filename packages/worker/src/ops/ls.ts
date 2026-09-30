// Ls operation (issue #13, slice A; §9.1).
// Thin over ExecutionEnv.fs. replay:"safe" — listing has no side effects.

import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface LsArgs {
  path?: string;
}

export interface LsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface LsResult {
  path: string;
  entries: LsEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateLsArgs(raw: unknown): LsArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'ls args must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'path') {
      throw new OpError(
        'invalid_args',
        `ls: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (
    raw.path !== undefined &&
    (typeof raw.path !== 'string' || raw.path.length === 0)
  ) {
    throw new OpError('invalid_args', 'ls: path must be a non-empty string');
  }
  return { path: raw.path as string | undefined };
}

export const lsOperation: Operation<LsArgs, LsResult> = {
  name: 'ls',
  description:
    'List one directory (not recursive): every entry with its kind and size. path defaults to the workspace root.',
  replay: 'safe',
  validateArgs: validateLsArgs,
  execute: async (_inv: ToolInvocation, args: LsArgs, ctx: OpContext) => {
    const path = args.path ?? '.';
    let names: string[];
    try {
      names = ctx.env.fs.listDir(path);
    } catch {
      throw new OpError('not_found', `ls: no such directory: ${path}`);
    }
    const entries: LsEntry[] = [];
    for (const name of names) {
      let st: { isFile: boolean; isDirectory: boolean; size: number };
      try {
        st = ctx.env.fs.stat(path === '.' ? name : `${path}/${name}`);
      } catch {
        continue;
      }
      entries.push({
        name,
        isFile: st.isFile,
        isDirectory: st.isDirectory,
        size: st.size,
      });
    }
    return { path, entries };
  },
};
