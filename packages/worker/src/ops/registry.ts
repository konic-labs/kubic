// Operation registry (issue #13, slice A).
// The registry IS the tool set: removing an entry makes the tool
// uncallable by construction — dispatch is a record lookup, and unknown
// names (or invalid args) become structured errors, never throws.

import type { EditResult } from './edit.js';
import { editOperation } from './edit.js';
import type { FindResult } from './find.js';
import { findOperation } from './find.js';
import type { GrepResult } from './grep.js';
import { grepOperation } from './grep.js';
import type { LsResult } from './ls.js';
import { lsOperation } from './ls.js';
import type { ReadResult } from './read.js';
import { readOperation } from './read.js';
import type {
  OpContext,
  Operation,
  OpResult,
  ToolInvocation,
} from './types.js';
import { OpError, refOf } from './types.js';
import type { WriteResult } from './write.js';
import { writeOperation } from './write.js';

export const OPERATIONS = {
  read: readOperation,
  ls: lsOperation,
  find: findOperation,
  grep: grepOperation,
  write: writeOperation,
  edit: editOperation,
} as const;

export type OperationName = keyof typeof OPERATIONS;

export interface OperationResults {
  read: ReadResult;
  ls: LsResult;
  find: FindResult;
  grep: GrepResult;
  write: WriteResult;
  edit: EditResult;
}

export function callOperation<N extends OperationName>(
  name: N,
  rawArgs: unknown,
  inv: ToolInvocation,
  ctx: OpContext,
): Promise<OpResult<OperationResults[N]>>;
export function callOperation(
  name: string,
  rawArgs: unknown,
  inv: ToolInvocation,
  ctx: OpContext,
): Promise<OpResult<unknown>>;
export async function callOperation(
  name: string,
  rawArgs: unknown,
  inv: ToolInvocation,
  ctx: OpContext,
): Promise<OpResult<unknown>> {
  const op = (OPERATIONS as Record<string, Operation<unknown, unknown>>)[name];
  if (!op) {
    return {
      ok: false,
      invocation: refOf(inv),
      error: { code: 'unknown_tool', message: `unknown tool: ${name}` },
    };
  }
  try {
    const args = op.validateArgs(rawArgs);
    const result = await op.execute(inv, args, ctx);
    return { ok: true, invocation: refOf(inv), result };
  } catch (err) {
    if (err instanceof OpError) {
      return {
        ok: false,
        invocation: refOf(inv),
        error: { code: err.code, message: err.message },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      invocation: refOf(inv),
      error: { code: 'internal', message },
    };
  }
}
