// Structured git operations (issue #19, slice A; §43.1).
// Git runs THROUGH the shell seam (spawn('git', ...) — no shell, no
// string commands), so provenance and the Fake script map apply as usual.
// This module never runs `git init`: repos are never created on the
// agent's behalf. Outside a repository every git op fails with the
// structured code `not_a_repo` (unavailable-with-reason, §43.2) — the
// journal path keeps working without git (VCS-independent).

import type { ExecutionEnv, Provenance } from '../../../exec/src/env.js';
import { OpError } from './types.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';

export interface GitRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

export async function runGit(
  env: ExecutionEnv,
  args: string[],
  provenance: Provenance,
): Promise<GitRun> {
  const handle = env.shell.spawn('git', args, { provenance });
  const done = await handle.wait();
  return {
    exitCode: done.exitCode,
    stdout: done.stdout,
    stderr: done.stderr,
  };
}

export function notARepoError(op: string, stderr: string): OpError {
  return new OpError(
    'not_a_repo',
    `${op}: unavailable — not a git repository (${stderr.trim().slice(0, 120)}). Journal diff/undo still work without git.`,
  );
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

function parsePorcelainStatus(out: string): GitStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch = '(unknown)';
  let ahead = 0;
  let behind = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const branchPart = head.split('...')[0] ?? head;
      branch =
        branchPart === 'No commits yet on' ||
        branchPart.startsWith('No commits yet')
          ? (head.split(' ').pop() ?? '(unknown)')
          : branchPart;
      const aheadMatch = /ahead (\d+)/.exec(head);
      const behindMatch = /behind (\d+)/.exec(head);
      if (aheadMatch?.[1] !== undefined) ahead = Number(aheadMatch[1]);
      if (behindMatch?.[1] !== undefined) behind = Number(behindMatch[1]);
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3).trim();
    if (x === '?' && y === '?') {
      untracked.push(path);
      continue;
    }
    if (x !== undefined && x !== ' ' && path !== '') staged.push(path);
    if (y !== undefined && y !== ' ' && path !== '') unstaged.push(path);
  }
  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean:
      staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

export type GitStatusResult = GitStatus;

export const gitStatusOperation: Operation<Record<string, never>, GitStatusResult> = {
  name: 'git_status',
  description: 'Structured working-tree status (branch, ahead/behind, staged/unstaged/untracked)',
  replay: 'safe',
  validateArgs: (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new OpError('invalid_args', 'git_status args must be an object');
    return {};
  },
  execute: async (inv: ToolInvocation, _args: Record<string, never>, ctx: OpContext): Promise<GitStatusResult> => {
    const run = await runGit(ctx.env, ['status', '--porcelain=v1', '-b'], {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: 0,
      operation: 'git_status',
    });
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_status', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_status failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return parsePorcelainStatus(run.stdout);
  },
};

export interface GitLogEntry {
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
}

const LOG_FORMAT = '%H%x1f%an%x1f%ad%x1f%s';

export const gitLogOperation: Operation<GitLogArgs, GitLogResult> = {
  name: 'git_log',
  description: 'Recent commits (sha, author, date, message), optionally for a path',
  replay: 'safe',
  validateArgs: (raw: unknown): GitLogArgs => {
    if (typeof raw !== 'object' || raw === null) throw new OpError('invalid_args', 'git_log args must be an object');
    const record = raw as Record<string, unknown>;
    if (record.max !== undefined && (typeof record.max !== 'number' || !Number.isInteger(record.max) || record.max < 1)) {
      throw new OpError('invalid_args', 'git_log max must be a positive integer');
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
      throw new OpError('invalid_args', 'git_log path must be a string');
    }
    return {
      ...(typeof record.max === 'number' ? { max: Math.min(record.max, 100) } : {}),
      ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
    };
  },
  execute: async (inv: ToolInvocation, args: GitLogArgs, ctx: OpContext): Promise<GitLogResult> => {
    const max = args.max ?? 20;
    const argv = ['log', `--format=${LOG_FORMAT}`, '--date=short', '-n', String(max)];
    if (args.path !== undefined) argv.push('--', args.path);
    const run = await runGit(ctx.env, argv, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: 0,
      operation: 'git_log',
    });
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_log', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_log failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    const entries: GitLogEntry[] = [];
    for (const line of run.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const [sha, author, date, message] = line.split('');
      if (sha === undefined || author === undefined || date === undefined || message === undefined) continue;
      entries.push({ sha, author, date, message });
    }
    return { entries };
  },
};

export interface GitShowArgs {
  ref: string;
}

export interface GitShowResult {
  patch: string;
}

export const gitShowOperation: Operation<GitShowArgs, GitShowResult> = {
  name: 'git_show',
  description: 'Patch (diff) of a commit or other ref',
  replay: 'safe',
  validateArgs: (raw: unknown): GitShowArgs => {
    if (typeof raw !== 'object' || raw === null) throw new OpError('invalid_args', 'git_show args must be an object');
    const ref = (raw as Record<string, unknown>).ref;
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new OpError('invalid_args', 'git_show ref must be a non-empty string');
    }
    if (ref.startsWith('-')) throw new OpError('invalid_args', 'git_show ref must not start with a dash');
    return { ref };
  },
  execute: async (inv: ToolInvocation, args: GitShowArgs, ctx: OpContext): Promise<GitShowResult> => {
    const run = await runGit(ctx.env, ['show', '--format=', '--patch', args.ref], {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: 0,
      operation: 'git_show',
    });
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_show', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_show failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { patch: run.stdout };
  },
};
export interface GitDiffArgs {
  staged?: boolean;
  range?: string;
  path?: string;
}

export interface GitDiffResult {
  diff: string;
}

export const gitDiffOperation: Operation<GitDiffArgs, GitDiffResult> = {
  name: 'git_diff',
  description: 'Scoped diff of staged changes, a revision range, or a path',
  replay: 'safe',
  validateArgs: (raw: unknown): GitDiffArgs => {
    if (typeof raw !== 'object' || raw === null) throw new OpError('invalid_args', 'git_diff args must be an object');
    const record = raw as Record<string, unknown>;
    if (record.staged !== undefined && typeof record.staged !== 'boolean') {
      throw new OpError('invalid_args', 'git_diff staged must be a boolean');
    }
    if (record.range !== undefined && typeof record.range !== 'string') {
      throw new OpError('invalid_args', 'git_diff range must be a string');
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
      throw new OpError('invalid_args', 'git_diff path must be a string');
    }
    return {
      ...(record.staged === true ? { staged: true as const } : {}),
      ...(typeof record.range === 'string' && record.range !== '' ? { range: record.range } : {}),
      ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
    };
  },
  execute: async (inv: ToolInvocation, args: GitDiffArgs, ctx: OpContext): Promise<GitDiffResult> => {
    // Explicit argv, never a shell string: range/path cannot inject flags
    // because anything after `--` is a path, and range is a single argv
    // element git parses as a revision (a leading `-` fails as unknown
    // revision, not as a flag).
    const argv = ['diff'];
    if (args.staged === true) argv.push('--staged');
    if (args.range !== undefined) argv.push(args.range);
    if (args.path !== undefined) argv.push('--', args.path);
    const run = await runGit(ctx.env, argv, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: 0,
      operation: 'git_diff',
    });
    if (run.exitCode !== 0) {
      if (isNotARepo(run.stderr)) throw notARepoError('git_diff', run.stderr);
      throw new OpError(
        'tool_failed',
        `git_diff failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`,
      );
    }
    return { diff: run.stdout };
  },
};
