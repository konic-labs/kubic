// Operation registry (issue #13, slice A).
// The registry IS the tool set: removing an entry makes the tool
// uncallable by construction — dispatch is a record lookup, and unknown
// names (or invalid args) become structured errors, never throws.
//
// Never-replay guard (§20.2, §20.3): effects (replay:"never") memoize
// their result under the invocation id. A worker retry or crash replay
// with the same invocation id returns the memoized result instead of
// re-executing — effects never re-invoke.

import type { BashResult } from './bash.js';
import { bashOperation } from './bash.js';
import type { EditResult } from './edit.js';
import { editOperation } from './edit.js';
import type { FindResult } from './find.js';
import { findOperation } from './find.js';
import type { GrepResult } from './grep.js';
import { grepOperation } from './grep.js';
import type { GitBranchResult, GitCheckpointResult, GitCommitResult, GitDiffResult, GitLogResult, GitShowResult, GitStageResult, GitStatusResult } from './git.js';
import { gitBranchOperation, gitCheckpointOperation, gitCommitOperation, gitDiffOperation, gitLogOperation, gitShowOperation, gitStageOperation, gitStatusOperation } from './git.js';
import type { LsResult } from './ls.js';
import { lsOperation } from './ls.js';
import type { ReadResult } from './read.js';
import { readOperation } from './read.js';
import type {
  JsonValue,
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
  bash: bashOperation,
  git_status: gitStatusOperation,
  git_diff: gitDiffOperation,
  git_log: gitLogOperation,
  git_show: gitShowOperation,
  git_stage: gitStageOperation,
  git_commit: gitCommitOperation,
  git_branch: gitBranchOperation,
  git_checkpoint: gitCheckpointOperation,
} as const;

export type OperationName = keyof typeof OPERATIONS;

export interface OperationResults {
  read: ReadResult;
  ls: LsResult;
  find: FindResult;
  grep: GrepResult;
  write: WriteResult;
  edit: EditResult;
  bash: BashResult;
  git_status: GitStatusResult;
  git_diff: GitDiffResult;
  git_log: GitLogResult;
  git_show: GitShowResult;
  git_stage: GitStageResult;
  git_commit: GitCommitResult;
  git_branch: GitBranchResult;
  git_checkpoint: GitCheckpointResult;
}

export function callOperation<N extends OperationName>(
  name: N,
  rawArgs: unknown,
  inv: ToolInvocation,
  ctx: OpContext,
): Promise<OpResult<OperationResults[N]>>;
// Untyped fallback: unknown names compile here and fail at runtime with
// `unknown_tool`. Typed call sites should use OperationName so that
// removing an operation breaks them at compile time.
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
    if (op.replay === 'never') {
      // Pi forbids ':' in memo names (validateMemoName) — the dash keeps
      // this key legal on a real lane, where the faux ids already proved
      // a colon key fails every never-replay op.
      const memoKey = `op-result-${name}`;
      const memoized = await inv.getMemo(memoKey);
      if (memoized !== undefined) {
        return {
          ok: true,
          invocation: refOf(inv),
          result: memoized as unknown,
        };
      }
      const result = await op.execute(inv, args, ctx);
      await inv.setMemo(memoKey, result as unknown as JsonValue);
      return { ok: true, invocation: refOf(inv), result };
    }
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
