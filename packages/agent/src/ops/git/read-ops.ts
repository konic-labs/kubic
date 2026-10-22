// The read-only git operations: status, log, show, diff, conflict status
// and the worktree list.
import {
  BASH_RESULT_MAX_CHARS,
  BASH_RESULT_MAX_LINES,
  clipStream,
} from '../bash.js';
import type { OpContext, Operation, ToolInvocation } from '../types.js';
import { OpError, rejectUnknownArgs } from '../types.js';
import type { GitStatus, GitSubmodule, GitWorktreeRow } from './porcelain.js';
import {
  parsePorcelainStatus,
  parseSubmoduleStatus,
  parseWorktreeList,
} from './porcelain.js';
import { gitStatSummary, isNotARepo, notARepoError, runGit } from './run.js';

export type GitStatusResult = GitStatus;

export const gitStatusOperation: Operation<
  Record<string, never>,
  GitStatusResult
> = {
  name: 'git_status',
  description:
    'Structured working-tree status (branch or detached HEAD, ahead/behind, staged/unstaged/untracked, conflicts, renames)',
  replay: 'safe',
  validateArgs: (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_status args must be an object');
    rejectUnknownArgs('git_status', raw, []);
    return {};
  },
  execute: async (
    inv: ToolInvocation,
    _args: Record<string, never>,
    ctx: OpContext,
  ): Promise<GitStatusResult> => {
    const run = await runGit(ctx, inv, 'git_status', [
      'status',
      '--porcelain=v2',
      '-z',
      '-b',
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_status', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_status failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    // The root and submodule summary ride along: both are cheap, local,
    // read-only queries, and a status without them drops the context a
    // agent needs to interpret the paths. Either may fail on an exotic
    // repo — the status itself still stands.
    let repoRoot = '';
    const root = await runGit(ctx, inv, 'git_status', [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (root.exitCode === 0) repoRoot = root.stdout.trim();
    let submodules: GitSubmodule[] = [];
    const subs = await runGit(ctx, inv, 'git_status', ['submodule', 'status']);
    if (subs.exitCode === 0) submodules = parseSubmoduleStatus(subs.stdout);
    return { ...parsePorcelainStatus(run.stdout), repoRoot, submodules };
  },
};

interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface GitLogArgs {
  max?: number;
  path?: string;
}

export interface GitLogResult {
  entries: GitLogEntry[];
  /** True when the raw log was clipped to the model cap. */
  truncated: boolean;
  /** Spill path holding the full log, when the lane provided a sink. */
  spillPath?: string;
  // Capped `--stat` summary, present only when truncated —
  // the shape of what the clip dropped.
  stat?: string;
}

const LOG_FORMAT = '%H%x1f%an%x1f%ad%x1f%s';

export const gitLogOperation: Operation<GitLogArgs, GitLogResult> = {
  name: 'git_log',
  description: `Recent commits (sha, author, date, message), optionally only those touching path; max defaults to 20 and is capped at 100. Output clips to the shared model cap (last ${BASH_RESULT_MAX_LINES} lines, at most ${BASH_RESULT_MAX_CHARS} chars, tail-kept; truncated reports the cut and the full text is spilled when the lane provides a sink)`,
  replay: 'safe',
  validateArgs: (raw: unknown): GitLogArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_log args must be an object');
    rejectUnknownArgs('git_log', raw, ['max', 'path']);
    const record = raw as Record<string, unknown>;
    if (
      record.max !== undefined &&
      (typeof record.max !== 'number' ||
        !Number.isInteger(record.max) ||
        record.max < 1)
    ) {
      throw new OpError(
        'invalid_args',
        'git_log max must be a positive integer',
      );
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
      throw new OpError('invalid_args', 'git_log path must be a string');
    }
    return {
      ...(typeof record.max === 'number'
        ? { max: Math.min(record.max, 100) }
        : {}),
      ...(typeof record.path === 'string' && record.path !== ''
        ? { path: record.path }
        : {}),
    };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitLogArgs,
    ctx: OpContext,
  ): Promise<GitLogResult> => {
    const max = args.max ?? 20;
    const argv = [
      'log',
      `--format=${LOG_FORMAT}`,
      '--date=short',
      '-n',
      String(max),
    ];
    if (args.path !== undefined) argv.push('--', args.path);
    const run = await runGit(ctx, inv, 'git_log', argv);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_log', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_log failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    // Clip the raw log before parsing: a cut first line
    // carries fewer than four fields and is skipped below, so a clipped
    // tail still parses cleanly.
    const clipped = clipStream('stdout', run.stdout, ctx);
    const entries: GitLogEntry[] = [];
    for (const line of clipped.text.split('\n')) {
      if (line.trim() === '') continue;
      const [sha, author, date, message] = line.split('');
      if (
        sha === undefined ||
        author === undefined ||
        date === undefined ||
        message === undefined
      )
        continue;
      entries.push({ sha, author, date, message });
    }
    const stat = clipped.truncated
      ? await gitStatSummary(ctx, inv, 'git_log', [
          'log',
          '--stat',
          `--format=${LOG_FORMAT}`,
          '--date=short',
          '-n',
          String(max),
          ...(args.path === undefined ? [] : ['--', args.path]),
        ])
      : undefined;
    return {
      entries,
      truncated: clipped.truncated,
      ...(clipped.spillPath === undefined
        ? {}
        : { spillPath: clipped.spillPath }),
      ...(stat === undefined ? {} : { stat }),
    };
  },
};

export interface GitShowArgs {
  ref: string;
}

export interface GitShowResult {
  patch: string;
  /** True when the patch was clipped to the model cap. */
  truncated: boolean;
  // Capped `--stat` summary, present only when truncated.
  stat?: string;
  /** Spill path holding the full patch, when the lane provided a sink. */
  spillPath?: string;
}

export const gitShowOperation: Operation<GitShowArgs, GitShowResult> = {
  name: 'git_show',
  description: `Patch (diff) of a commit or other ref. Output clips to the shared model cap (last ${BASH_RESULT_MAX_LINES} lines, at most ${BASH_RESULT_MAX_CHARS} chars, tail-kept; truncated reports the cut and the full text is spilled when the lane provides a sink)`,
  replay: 'safe',
  validateArgs: (raw: unknown): GitShowArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_show args must be an object');
    rejectUnknownArgs('git_show', raw, ['ref']);
    const ref = (raw as Record<string, unknown>).ref;
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new OpError(
        'invalid_args',
        'git_show ref must be a non-empty string',
      );
    }
    if (ref.startsWith('-'))
      throw new OpError(
        'invalid_args',
        'git_show ref must not start with a dash',
      );
    return { ref };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitShowArgs,
    ctx: OpContext,
  ): Promise<GitShowResult> => {
    const run = await runGit(ctx, inv, 'git_show', [
      'show',
      '--format=',
      '--patch',
      args.ref,
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_show', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_show failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    const clipped = clipStream('stdout', run.stdout, ctx);
    const stat = clipped.truncated
      ? await gitStatSummary(ctx, inv, 'git_show', [
          'show',
          '--format=',
          '--stat',
          args.ref,
        ])
      : undefined;
    return {
      patch: clipped.text,
      truncated: clipped.truncated,
      ...(clipped.spillPath === undefined
        ? {}
        : { spillPath: clipped.spillPath }),
      ...(stat === undefined ? {} : { stat }),
    };
  },
};
export interface GitDiffArgs {
  staged?: boolean;
  range?: string;
  path?: string;
}

export interface GitDiffResult {
  diff: string;
  /** True when the diff was clipped to the model cap. */
  truncated: boolean;
  /** Spill path holding the full diff, when the lane provided a sink. */
  spillPath?: string;
  // Capped `--stat` summary, present only when truncated.
  stat?: string;
}

export const gitDiffOperation: Operation<GitDiffArgs, GitDiffResult> = {
  name: 'git_diff',
  description: `Scoped diff of staged changes, a revision range, or a path. Output clips to the shared model cap (last ${BASH_RESULT_MAX_LINES} lines, at most ${BASH_RESULT_MAX_CHARS} chars, tail-kept; truncated reports the cut and the full text is spilled when the lane provides a sink)`,
  replay: 'safe',
  validateArgs: (raw: unknown): GitDiffArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_diff args must be an object');
    rejectUnknownArgs('git_diff', raw, ['staged', 'range', 'path']);
    const record = raw as Record<string, unknown>;
    if (record.staged !== undefined && typeof record.staged !== 'boolean') {
      throw new OpError('invalid_args', 'git_diff staged must be a boolean');
    }
    if (record.range !== undefined && typeof record.range !== 'string') {
      throw new OpError('invalid_args', 'git_diff range must be a string');
    }
    if (
      typeof record.range === 'string' &&
      record.range !== '' &&
      record.range.startsWith('-')
    ) {
      // A leading dash would be parsed by git as a flag (e.g. --output):
      // ranges name revisions, never flags.
      throw new OpError(
        'invalid_args',
        'git_diff range must not start with a dash',
      );
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
      throw new OpError('invalid_args', 'git_diff path must be a string');
    }
    return {
      ...(record.staged === true ? { staged: true as const } : {}),
      ...(typeof record.range === 'string' && record.range !== ''
        ? { range: record.range }
        : {}),
      ...(typeof record.path === 'string' && record.path !== ''
        ? { path: record.path }
        : {}),
    };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitDiffArgs,
    ctx: OpContext,
  ): Promise<GitDiffResult> => {
    // Explicit argv, never a shell string: range/path cannot inject flags
    // because anything after `--` is a path, and range is a single argv
    // element git parses as a revision (a leading `-` fails as unknown
    // revision, not as a flag).
    const argv = ['diff'];
    if (args.staged === true) argv.push('--staged');
    if (args.range !== undefined) argv.push(args.range);
    if (args.path !== undefined) argv.push('--', args.path);
    const run = await runGit(ctx, inv, 'git_diff', argv);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_diff', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_diff failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    const clipped = clipStream('stdout', run.stdout, ctx);
    const stat = clipped.truncated
      ? await gitStatSummary(ctx, inv, 'git_diff', [
          'diff',
          ...(args.staged === true ? ['--staged'] : []),
          ...(args.range === undefined ? [] : [args.range]),
          '--stat',
          ...(args.path === undefined ? [] : ['--', args.path]),
        ])
      : undefined;
    return {
      diff: clipped.text,
      truncated: clipped.truncated,
      ...(clipped.spillPath === undefined
        ? {}
        : { spillPath: clipped.spillPath }),
      ...(stat === undefined ? {} : { stat }),
    };
  },
};

export interface GitConflictStatusResult {
  conflicts: string[];
}

export const gitConflictStatusOperation: Operation<
  Record<string, never>,
  GitConflictStatusResult
> = {
  name: 'git_conflict_status',
  description: 'List paths with unresolved merge conflicts',
  replay: 'safe',
  validateArgs: (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError(
        'invalid_args',
        'git_conflict_status args must be an object',
      );
    rejectUnknownArgs('git_conflict_status', raw, []);
    return {};
  },
  execute: async (
    inv: ToolInvocation,
    _args: Record<string, never>,
    ctx: OpContext,
  ): Promise<GitConflictStatusResult> => {
    const run = await runGit(ctx, inv, 'git_conflict_status', [
      'status',
      '--porcelain=v2',
      '-z',
      '-b',
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr))
        throw notARepoError('git_conflict_status', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_conflict_status failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { conflicts: parsePorcelainStatus(run.stdout).conflicts };
  },
};

export interface GitWorktreeListResult {
  worktrees: GitWorktreeRow[];
}

export const gitWorktreeListOperation: Operation<
  Record<string, never>,
  GitWorktreeListResult
> = {
  name: 'git_worktree_list',
  description: 'List attached worktrees (path, branch, HEAD)',
  replay: 'safe',
  validateArgs: (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError(
        'invalid_args',
        'git_worktree_list args must be an object',
      );
    rejectUnknownArgs('git_worktree_list', raw, []);
    return {};
  },
  execute: async (
    inv: ToolInvocation,
    _args: Record<string, never>,
    ctx: OpContext,
  ): Promise<GitWorktreeListResult> => {
    const run = await runGit(ctx, inv, 'git_worktree_list', [
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr))
        throw notARepoError('git_worktree_list', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_worktree_list failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { worktrees: parseWorktreeList(run.stdout) };
  },
};
