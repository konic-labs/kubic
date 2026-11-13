// Operation registry.
// The registry IS the tool set: removing an entry makes the tool
// uncallable by construction — dispatch is a record lookup, and unknown
// names (or invalid args) become structured errors, never throws.
//
// Never-replay guard: a caller WITHOUT its own replay gate
// (`ToolInvocation.keepEffectMemo`) memoizes an effect's result under the
// invocation id, so a retry or crash replay with the same invocation id
// returns the memoized result instead of re-executing. On the lane the
// memo is skipped: pi-durable's `replay: 'unsafe'` already settles an
// interrupted effect without re-entering execute, so the copy could never
// be read and would cost a second durable write per effect.

import {
  arr,
  bool,
  int,
  num,
  obj,
  opt,
  type Schema,
  str,
  union,
  unsafe,
} from '../pi-boundary.js';
import type { BashResult } from './bash.js';
import { bashOperation } from './bash.js';
import type { EditResult } from './edit.js';
import { editOperation } from './edit.js';
import type { FindResult } from './find.js';
import { FIND_DEFAULT_MAX, findOperation } from './find.js';
import type {
  GitBranchResult,
  GitCheckpointResult,
  GitCommitResult,
  GitConflictStatusResult,
  GitDiffResult,
  GitLogResult,
  GitMergeResult,
  GitShowResult,
  GitStageResult,
  GitStatusResult,
  GitWorktreeListResult,
} from './git/index.js';
import {
  gitBranchOperation,
  gitCheckpointOperation,
  gitCommitOperation,
  gitConflictStatusOperation,
  gitDiffOperation,
  gitLogOperation,
  gitMergeOperation,
  gitShowOperation,
  gitStageOperation,
  gitStatusOperation,
  gitWorktreeListOperation,
} from './git/index.js';
import type { GrepResult } from './grep.js';
import { GREP_DEFAULT_MAX, grepOperation } from './grep.js';
import type { LsResult } from './ls.js';
import { lsOperation } from './ls.js';
import type { ReadResult } from './read.js';
import { READ_MAX_LINES, readOperation } from './read.js';
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
  git_merge: gitMergeOperation,
  git_conflict_status: gitConflictStatusOperation,
  git_worktree_list: gitWorktreeListOperation,
} as const;

export type OperationName = keyof typeof OPERATIONS;

// Tool parameter schemas: the SINGLE source of
// what each operation accepts, as the model sees it and as Pi validates it
// before a call runs. Kubic's validators stay authoritative (they also
// check what a schema cannot, e.g. a compilable regex or a dash-free ref);
// registry-schema.test.ts pins that the two accept the same keys. Every
// object is closed (`additionalProperties: false`, pi-schema's `obj`
// default) — the validators reject unknown keys too, so a guessed
// `file_path` fails fast with the real argument names in view.
// A string literal keeps its `type` (pi-schema's `lit` writes only `const`):
// some providers refuse a schema node without one.
const literal = <V extends string>(value: V) =>
  unsafe<V>({ type: 'string', const: value });
const nonEmpty = (description: string) => str({ minLength: 1, description });
const positiveInt = (description: string) => int({ minimum: 1, description });

export const OPERATION_PARAMETERS: { readonly [N in OperationName]: Schema } = {
  read: obj({
    path: nonEmpty('File path, relative to the workspace root.'),
    offset: opt(positiveInt('1-indexed line to start from (default 1).')),
    limit: opt(
      positiveInt(
        `Maximum lines to return (default and cap ${READ_MAX_LINES}).`,
      ),
    ),
  }),
  ls: obj({
    path: opt(
      nonEmpty('Directory to list, relative to the workspace (default ".").'),
    ),
  }),
  find: obj({
    root: opt(nonEmpty('Directory to search from (default ".").')),
    nameContains: opt(
      str({
        description: 'Only entries whose name contains this substring.',
      }),
    ),
    type: opt(
      union([literal('file'), literal('dir')], {
        description: 'Only files ("file") or only directories ("dir").',
      }),
    ),
    maxResults: opt(
      positiveInt(`Maximum entries to return (default ${FIND_DEFAULT_MAX}).`),
    ),
  }),
  grep: obj({
    pattern: nonEmpty(
      'JavaScript regular expression, matched against each line.',
    ),
    root: opt(nonEmpty('Directory to search from (default ".").')),
    include: opt(
      str({
        description:
          'Only files whose path contains this substring (not a glob), e.g. ".ts".',
      }),
    ),
    maxMatches: opt(
      positiveInt(`Maximum matching lines (default ${GREP_DEFAULT_MAX}).`),
    ),
  }),
  write: obj({
    path: nonEmpty('File path, relative to the workspace root.'),
    content: str({
      description: 'The complete new file content (replaces the file).',
    }),
  }),
  edit: obj({
    path: nonEmpty('File path, relative to the workspace root.'),
    oldText: nonEmpty(
      'Exact text to replace, byte for byte (whitespace included).',
    ),
    newText: str({ description: 'Replacement text.' }),
    expectCount: opt(
      positiveInt(
        'Exact number of occurrences oldText must have (default 1); any other count is refused and nothing changes.',
      ),
    ),
  }),
  bash: obj({
    command: nonEmpty('Shell command line, run in the workspace root.'),
    timeout: opt(
      num({
        exclusiveMinimum: 0,
        description: 'Timeout in SECONDS (not milliseconds).',
      }),
    ),
  }),
  git_status: obj({}),
  git_diff: obj({
    staged: opt(bool({ description: 'Diff the index (staged changes).' })),
    range: opt(
      str({
        description:
          'Revision or range, e.g. "HEAD~1..HEAD" (no leading dash).',
      }),
    ),
    path: opt(str({ description: 'Limit the diff to this path.' })),
  }),
  git_log: obj({
    max: opt(positiveInt('Commits to return (default 20, capped at 100).')),
    path: opt(str({ description: 'Only commits touching this path.' })),
  }),
  git_show: obj({
    ref: nonEmpty('Commit or ref to show, e.g. "HEAD" (no leading dash).'),
  }),
  git_stage: obj({
    paths: arr(str(), {
      minItems: 1,
      description: 'Explicit paths to stage (never "-A").',
    }),
  }),
  git_commit: obj({
    message: nonEmpty('Commit message.'),
    amend: opt(bool({ description: 'Amend the previous commit.' })),
  }),
  git_branch: obj({
    create: opt(
      str({
        description:
          'Name of a branch to create; omit to list branches (no checkout).',
      }),
    ),
  }),
  git_checkpoint: obj({
    message: nonEmpty('Label for the restorable stash point.'),
  }),
  git_merge: obj({
    branch: nonEmpty('Local branch to merge into the current one.'),
  }),
  git_conflict_status: obj({}),
  git_worktree_list: obj({}),
};

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
  git_merge: GitMergeResult;
  git_conflict_status: GitConflictStatusResult;
  git_worktree_list: GitWorktreeListResult;
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
    if (op.replay === 'never' && inv.keepEffectMemo) {
      // The memo key is legal for pi-durable's memo validation (no ':').
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
    // A caller whose engine refuses to re-execute the op
    // (`keepEffectMemo: false`) skips the memo entirely — see
    // ToolInvocation.keepEffectMemo.
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
