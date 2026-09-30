// Structured git operations (issue #19, slice A; §43.1).
// Git runs THROUGH the shell seam (spawn('git', ...) — no shell, no
// string commands), so provenance and the Fake script map apply as usual.
// This module never runs `git init`: repos are never created on the
// agent's behalf. Outside a repository every git op fails with the
// structured code `not_a_repo` (unavailable-with-reason, §43.2) — the
// journal path keeps working without git (VCS-independent).

import type { ExecutionEnv, Provenance } from '../../../exec/src/env.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError, rejectUnknownArgs } from './types.js';

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

export interface GitRename {
  /** The file's current (new) path. */
  path: string;
  /** The path it came from; omitted when git records no original. */
  oldPath?: string;
  /** True when the rename/copy is recorded in the index (staged). */
  staged: boolean;
}

export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** Rename/copy records: the new path plus the optional old path. */
  renames: GitRename[];
  clean: boolean;
}

// Input is always `git status --porcelain=v2 -z -b`: NUL-delimited records
// mean git never quotes paths, so non-ASCII, whitespace and quote
// characters round-trip verbatim; type-2 records spell renames and copies
// out as new path + original path instead of v1's `old -> new` string; and
// the branch headers separate a detached HEAD (`# branch.head (detached)`)
// from a branch name — never guessed from one — while an unborn branch is
// just a name next to `# branch.oid (initial)`.
function parsePorcelainStatus(out: string): GitStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const renames: GitRename[] = [];
  let branch: string | null = '(unknown)';
  let ahead = 0;
  let behind = 0;

  const pushChange = (xy: string, path: string, oldPath?: string): void => {
    if (path === '') return;
    const x = xy[0] ?? '';
    const y = xy[1] ?? '';
    if (x !== '' && x !== '.') staged.push(path);
    if (y !== '' && y !== '.') unstaged.push(path);
    if (oldPath !== undefined && oldPath !== '') {
      renames.push({ path, oldPath, staged: x === 'R' || x === 'C' });
    }
  };

  const records = out.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record === '') continue;
    if (record.startsWith('# ')) {
      const header = record.slice(2);
      if (header.startsWith('branch.head ')) {
        const head = header.slice('branch.head '.length).trim();
        branch =
          head === '(detached)' ? null : head === '' ? '(unknown)' : head;
      } else if (header.startsWith('branch.ab ')) {
        const counts = /^branch\.ab \+(\d+) -(\d+)$/.exec(header);
        if (counts !== null) {
          ahead = Number(counts[1]);
          behind = Number(counts[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '1' || kind === 'u') {
      // Path is the last field and may contain spaces: only the fixed
      // fields before it are single-space separated.
      const fields = record.split(' ');
      pushChange(
        fields[1] ?? '',
        fields.slice(kind === '1' ? 8 : 10).join(' '),
      );
      continue;
    }
    if (kind === '2') {
      // A type-2 record's original path is the next NUL-delimited field,
      // not a record of its own.
      const fields = record.split(' ');
      const path = fields.slice(9).join(' ');
      const oldPath = records[index + 1] ?? '';
      index += 1;
      pushChange(fields[1] ?? '', path, oldPath);
      continue;
    }
    if (kind === '?') {
      const path = record.slice(2);
      if (path !== '') untracked.push(path);
    }
    // `!` (ignored) is not requested by `--porcelain=v2`; nothing else can
    // appear in this format.
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    renames,
    clean:
      staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

export type GitStatusResult = GitStatus;

export const gitStatusOperation: Operation<
  Record<string, never>,
  GitStatusResult
> = {
  name: 'git_status',
  description:
    'Structured working-tree status (branch or detached HEAD, ahead/behind, staged/unstaged/untracked, renames)',
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
    const run = await runGit(
      ctx.env,
      ['status', '--porcelain=v2', '-z', '-b'],
      {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        toolCallId: inv.invocationId,
        turnId: 0,
        operation: 'git_status',
      },
    );
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
  description:
    'Recent commits (sha, author, date, message), optionally only those touching path; max defaults to 20 and is capped at 100',
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
      if (
        sha === undefined ||
        author === undefined ||
        date === undefined ||
        message === undefined
      )
        continue;
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
    const run = await runGit(
      ctx.env,
      ['show', '--format=', '--patch', args.ref],
      {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        toolCallId: inv.invocationId,
        turnId: 0,
        operation: 'git_show',
      },
    );
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

export interface GitStageArgs {
  paths: string[];
}

export interface GitStageResult {
  staged: string[];
}

function gitEffectProvenance(
  inv: ToolInvocation,
  ctx: OpContext,
  operation: string,
): {
  sessionId: string;
  agentId: string;
  toolCallId: string;
  turnId: number;
  operation: string;
} {
  return {
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    toolCallId: inv.invocationId,
    turnId: 0,
    operation,
  };
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

export function isValidBranchName(name: string): boolean {
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
    const run = await runGit(
      ctx.env,
      ['add', '--', ...args.paths],
      gitEffectProvenance(inv, ctx, 'git_stage'),
    );
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
    'Commit staged changes; returns sha + file list (trajectory records commits from this result in EPIC F)',
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
    const run = await runGit(
      ctx.env,
      argv,
      gitEffectProvenance(inv, ctx, 'git_commit'),
    );
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
    const head = await runGit(
      ctx.env,
      ['rev-parse', 'HEAD'],
      gitEffectProvenance(inv, ctx, 'git_commit'),
    );
    const sha = head.stdout.trim();
    if (sha === '')
      throw new OpError(
        'tool_failed',
        'git_commit succeeded but rev-parse HEAD is empty',
      );
    const files = await runGit(
      ctx.env,
      ['show', '-z', '--name-only', '--format=', sha],
      gitEffectProvenance(inv, ctx, 'git_commit'),
    );
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
    const run = await runGit(
      ctx.env,
      ['stash', 'create', args.message],
      gitEffectProvenance(inv, ctx, 'git_checkpoint'),
    );
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
    'List branches, or create one (checkout is out of scope: solo works on the current branch)',
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
      const run = await runGit(
        ctx.env,
        ['branch', args.create],
        gitEffectProvenance(inv, ctx, 'git_branch'),
      );
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
      ctx.env,
      // for-each-ref over refs/heads, not `git branch`: on a detached HEAD
      // `git branch` prints a "(HEAD detached at …)" pseudo-entry, and
      // `:short` would render a branch that shares its name with a tag as
      // `heads/<name>`. lstrip=2 drops exactly `refs/heads/`.
      ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'],
      gitEffectProvenance(inv, ctx, 'git_branch'),
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
