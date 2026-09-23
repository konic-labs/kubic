// Edit operation (issue #13, slice C; §9.1).
// Exact-match replacement with an explicit expected count: the default of 1
// refuses ambiguous matches instead of guessing. Atomic via tmp+rename.
// replay:"never" — edits are effects, never re-executed on replay.

import { sha256Hex } from './hash.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface EditArgs {
  path: string;
  oldText: string;
  newText: string;
  expectCount?: number;
}

export interface EditResult {
  path: string;
  replacements: number;
  beforeHash: string;
  afterHash: string;
  bytesDelta: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEditArgs(raw: unknown): EditArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'edit args must be an object');
  for (const key of Object.keys(raw)) {
    if (
      key !== 'path' &&
      key !== 'oldText' &&
      key !== 'newText' &&
      key !== 'expectCount'
    ) {
      throw new OpError(
        'invalid_args',
        `edit: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new OpError('invalid_args', 'edit: path must be a non-empty string');
  }
  if (typeof raw.oldText !== 'string' || raw.oldText.length === 0) {
    throw new OpError(
      'invalid_args',
      'edit: oldText must be a non-empty string',
    );
  }
  if (typeof raw.newText !== 'string') {
    throw new OpError('invalid_args', 'edit: newText must be a string');
  }
  if (
    raw.expectCount !== undefined &&
    (!Number.isInteger(raw.expectCount) || (raw.expectCount as number) < 1)
  ) {
    throw new OpError(
      'invalid_args',
      'edit: expectCount must be a positive integer',
    );
  }
  return {
    path: raw.path,
    oldText: raw.oldText,
    newText: raw.newText,
    expectCount: raw.expectCount as number | undefined,
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export const editOperation: Operation<EditArgs, EditResult> = {
  name: 'edit',
  description: 'Replace exact text matches atomically (tmp + rename)',
  replay: 'never',
  validateArgs: validateEditArgs,
  execute: async (_inv: ToolInvocation, args: EditArgs, ctx: OpContext) => {
    let current: string;
    try {
      current = ctx.env.fs.readFile(args.path);
    } catch {
      throw new OpError('not_found', `edit: no such file: ${args.path}`);
    }
    const expected = args.expectCount ?? 1;
    const found = countOccurrences(current, args.oldText);
    if (found === 0) {
      throw new OpError('no_match', `edit: oldText not found in ${args.path}`);
    }
    if (found !== expected) {
      throw new OpError(
        'ambiguous_match',
        `edit: found ${found} matches in ${args.path}, expected ${expected}`,
      );
    }
    const updated = current.split(args.oldText).join(args.newText);
    const beforeHash = sha256Hex(current);
    const tmp = `${args.path}.kubic-tmp`;
    ctx.env.fs.writeFile(tmp, updated);
    ctx.env.fs.rename(tmp, args.path);
    return {
      path: args.path,
      replacements: found,
      beforeHash,
      afterHash: sha256Hex(updated),
      bytesDelta: updated.length - current.length,
    };
  },
};
