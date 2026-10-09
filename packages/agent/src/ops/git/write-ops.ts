// The git operations that change the repository: stage, commit, checkpoint,
// branch and merge.

import type { OpContext, Operation, ToolInvocation } from '../types.js';
import { OpError, rejectUnknownArgs } from '../types.js';
import { parsePorcelainStatus } from './porcelain.js';
import { isNotARepo, notARepoError, runGit } from './run.js';

export interface GitStageArgs {
  paths: string[];
}

export interface GitStageResult {
  staged: string[];
}

function rejectPathEscape(path: string, op: string): void {
  // Any `..` segment anywhere (not just leading): `a/../../x` escapes the
  // same as `../x` once git resolves it.
  if (
    path === '' ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new OpError(
      'invalid_args',
      `${op}: refusing path '${path}' (empty, absolute, or parent-escaping)`,
    );
  }
}

function isValidBranchName(name: string): boolean {
  if (name === '') return false;
  if (name.startsWith('-') || name.includes('..') || name.includes('@{')) {
    return false;
  }
  if (/[\s~^:?*[\]\\]/.test(name)) return false;
  if (
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.includes('//')
  ) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

export const gitStageOperation: Operation<GitStageArgs, GitStageResult> = {
  name: 'git_stage',
  description:
    'Stage explicit paths (never -A: the agent stages what it means)',
  replay: 'never',
  validateArgs: (raw: unknown): GitStageArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_stage args must be an object');
    rejectUnknownArgs('git_stage', raw, ['paths']);
    const paths = (raw as Record<string, unknown>).paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new OpError(
        'invalid_args',
        'git_stage paths must be a non-empty array',
      );
    }
    for (const p of paths) {
      if (typeof p !== 'string')
        throw new OpError('invalid_args', 'git_stage paths must be strings');
      rejectPathEscape(p, 'git_stage');
    }
    return { paths };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitStageArgs,
    ctx: OpContext,
  ): Promise<GitStageResult> => {
    const run = await runGit(ctx, inv, 'git_stage', [
      'add',
      '--',
      ...args.paths,
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_stage', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_stage failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { staged: args.paths };
  },
};

export interface GitCommitArgs {
  message: string;
  amend?: boolean;
}

export interface GitCommitResult {
  sha: string;
  files: string[];
}

export const gitCommitOperation: Operation<GitCommitArgs, GitCommitResult> = {
  name: 'git_commit',
  description:
    'Commit staged changes; returns sha + file list (trajectory records commits from this result)',
  replay: 'never',
  validateArgs: (raw: unknown): GitCommitArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_commit args must be an object');
    rejectUnknownArgs('git_commit', raw, ['message', 'amend']);
    const record = raw as Record<string, unknown>;
    if (typeof record.message !== 'string' || record.message.trim() === '') {
      throw new OpError(
        'invalid_args',
        'git_commit message must be a non-empty string',
      );
    }
    if (record.amend !== undefined && typeof record.amend !== 'boolean') {
      throw new OpError('invalid_args', 'git_commit amend must be a boolean');
    }
    return {
      message: record.message,
      ...(record.amend === true ? { amend: true as const } : {}),
    };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitCommitArgs,
    ctx: OpContext,
  ): Promise<GitCommitResult> => {
    const argv = ['commit', '-m', args.message];
    if (args.amend === true) argv.push('--amend');
    const run = await runGit(ctx, inv, 'git_commit', argv);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_commit', run.stderr);
      // `git commit` with nothing staged exits 1 having written "nothing to
      // commit" to STDOUT and nothing to stderr: fall back to stdout so the
      // model sees why instead of an empty reason.
      const reason = run.stderr.trim() === '' ? run.stdout : run.stderr;
      throw new OpError(
        'tool_failed',
        `git_commit failed (exit ${run.exitCode}): ${reason.trim().slice(0, 200)}`,
      );
    }
    const head = await runGit(ctx, inv, 'git_commit', ['rev-parse', 'HEAD']);
    const sha = head.stdout.trim();
    if (sha === '')
      throw new OpError(
        'tool_failed',
        'git_commit succeeded but rev-parse HEAD is empty',
      );
    const files = await runGit(ctx, inv, 'git_commit', [
      'show',
      '-z',
      '--name-only',
      '--format=',
      sha,
    ]);
    // `-z` means NUL-separated and never quoted: non-ASCII and newline
    // paths come back exactly as committed (same parity as git_status).
    return {
      sha,
      files: files.stdout.split('\0').filter((f) => f !== ''),
    };
  },
};

export interface GitCheckpointArgs {
  message: string;
}

export interface GitCheckpointResult {
  sha: string;
}

export const gitCheckpointOperation: Operation<
  GitCheckpointArgs,
  GitCheckpointResult
> = {
  name: 'git_checkpoint',
  description:
    'Create a restorable stash point WITHOUT touching the tree (git stash create); restore with git stash apply <sha>',
  replay: 'never',
  validateArgs: (raw: unknown): GitCheckpointArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError(
        'invalid_args',
        'git_checkpoint args must be an object',
      );
    rejectUnknownArgs('git_checkpoint', raw, ['message']);
    const message = (raw as Record<string, unknown>).message;
    if (typeof message !== 'string' || message.trim() === '') {
      throw new OpError(
        'invalid_args',
        'git_checkpoint message must be a non-empty string',
      );
    }
    return { message };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitCheckpointArgs,
    ctx: OpContext,
  ): Promise<GitCheckpointResult> => {
    // `stash create` writes a stash commit object but no ref and leaves the
    // working tree alone — the checkpoint is restorable (stash apply <sha>)
    // without the checkpoint itself destroying work. The message is the
    // positional argument `stash create [<message>]` takes; `-m` is a
    // `stash push` option and would become part of the subject here.
    const run = await runGit(ctx, inv, 'git_checkpoint', [
      'stash',
      'create',
      args.message,
    ]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr))
        throw notARepoError('git_checkpoint', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_checkpoint failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    const sha = run.stdout.trim();
    if (sha === '') {
      throw new OpError(
        'tool_failed',
        'git_checkpoint: no changes to checkpoint (clean tree)',
      );
    }
    return { sha };
  },
};

export interface GitBranchArgs {
  create?: string;
}

export interface GitBranchResult {
  branches?: string[];
  created?: string;
}

export const gitBranchOperation: Operation<GitBranchArgs, GitBranchResult> = {
  name: 'git_branch',
  description:
    'List branches, or create one (checkout is out of scope: Kubic works on the current branch)',
  replay: 'never',
  validateArgs: (raw: unknown): GitBranchArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_branch args must be an object');
    rejectUnknownArgs('git_branch', raw, ['create']);
    const create = (raw as Record<string, unknown>).create;
    if (create !== undefined) {
      if (typeof create !== 'string' || !isValidBranchName(create)) {
        throw new OpError(
          'invalid_args',
          'git_branch create must be a plain branch name',
        );
      }
      return { create };
    }
    return {};
  },
  execute: async (
    inv: ToolInvocation,
    args: GitBranchArgs,
    ctx: OpContext,
  ): Promise<GitBranchResult> => {
    if (args.create !== undefined) {
      const run = await runGit(ctx, inv, 'git_branch', ['branch', args.create]);
      if (run.exitCode !== 0) {
        if (isNotARepo(run.stderr))
          throw notARepoError('git_branch', run.stderr);
        throw new OpError(
          'tool_failed',
          `git_branch failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
        );
      }
      return { created: args.create };
    }
    const run = await runGit(
      ctx,
      inv,
      'git_branch',
      // for-each-ref over refs/heads, not `git branch`: on a detached HEAD
      // `git branch` prints a "(HEAD detached at …)" pseudo-entry, and
      // `:short` would render a branch that shares its name with a tag as
      // `heads/<name>`. lstrip=2 drops exactly `refs/heads/`.
      ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'],
    );
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_branch', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_branch failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return {
      branches: run.stdout
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b !== ''),
    };
  },
};

export interface GitMergeArgs {
  branch: string;
}

export interface GitMergeResult {
  merged: boolean;
  /** Conflicted paths, when the merge stopped on conflicts. */
  conflicts: string[];
}

export const gitMergeOperation: Operation<GitMergeArgs, GitMergeResult> = {
  name: 'git_merge',
  description:
    'Merge a local branch into the current one (local refs only, never fetches); on conflict returns the conflicted paths and leaves the merge state for the resolver',
  replay: 'never',
  validateArgs: (raw: unknown): GitMergeArgs => {
    if (typeof raw !== 'object' || raw === null)
      throw new OpError('invalid_args', 'git_merge args must be an object');
    rejectUnknownArgs('git_merge', raw, ['branch']);
    const branch = (raw as Record<string, unknown>).branch;
    if (typeof branch !== 'string' || !isValidBranchName(branch)) {
      throw new OpError(
        'invalid_args',
        'git_merge branch must be a plain branch name',
      );
    }
    return { branch };
  },
  execute: async (
    inv: ToolInvocation,
    args: GitMergeArgs,
    ctx: OpContext,
  ): Promise<GitMergeResult> => {
    const run = await runGit(ctx, inv, 'git_merge', ['merge', args.branch]);
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_merge', run.stderr);
      // A conflicting merge exits non-zero with the tree in merge state:
      // report the conflicted paths and leave the state for the resolver
      // (no abort — resolving is the caller's job). Any other failure is
      // git's own words.
      const status = await runGit(ctx, inv, 'git_merge', [
        'status',
        '--porcelain=v2',
        '-z',
        '-b',
      ]);
      if (status.exitCode === 0) {
        const conflicts = parsePorcelainStatus(status.stdout).conflicts;
        if (conflicts.length > 0) return { merged: false, conflicts };
      }
      throw new OpError(
        'tool_failed',
        `git_merge failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { merged: true, conflicts: [] };
  },
};
