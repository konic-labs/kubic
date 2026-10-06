// Worktree status, settle, and post-merge retain (issue #45; §44, §44.1).
// Settle keeps the branch; a merged worktree stays retained by default
// (evidence) — only `kubic clean` disposes. Live status reads through
// the exec Shell seam (`git -C <path> status`, explicit argv).

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import type { GitRename } from '../../../../worker/src/ops/git.js';
import { parsePorcelainStatus } from '../../../../worker/src/ops/git.js';
import {
  isSpawnedWorktreePath,
  isSpawnedWorktreeShape,
} from './confinement.js';
import { WorktreeError } from './errors.js';
import type { WorktreeEntry } from './list.js';
import { DEFAULT_WORKTREE_ROOT } from './naming.js';

export interface WorktreeStatus {
  path: string;
  /** Current branch, or null when the worktree HEAD is detached. */
  branch: string | null;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** Rename/copy records, by new path with the old path available. */
  renames: GitRename[];
}

export type SettledWorktree = WorktreeEntry & {
  settled: true;
  branchKept: true;
};

export type MergedWorktree = WorktreeEntry & {
  merged: true;
  retained: true;
  removed: false;
};

// Settle: the branch stays on the worktree for evidence and follow-ups.
export function settleWorktree(entry: WorktreeEntry): SettledWorktree {
  return { ...entry, settled: true, branchKept: true };
}

// Retain post-merge (§44.1): merging never disposes the worktree or its
// branch — disposal is explicit-only via `kubic clean`.
export function markMerged(entry: WorktreeEntry): MergedWorktree {
  return { ...entry, merged: true, retained: true, removed: false };
}

export async function getWorktreeStatus(
  env: ExecutionEnv,
  path: string,
  options?: { sessionId?: string; repoRoot?: string; worktreeRoot?: string },
): Promise<WorktreeStatus> {
  if (!path.startsWith('/')) {
    throw new WorktreeError(
      'status_failed',
      'worktree path must be absolute',
      1,
    );
  }
  if (!isSpawnedWorktreeShape(path, options?.worktreeRoot)) {
    throw new WorktreeError(
      'status_failed',
      `refusing status for ${path}: not a spawned worktree under ${options?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT}/`,
      1,
    );
  }
  if (
    options?.repoRoot !== undefined &&
    !isSpawnedWorktreePath(options.repoRoot, path, options.worktreeRoot)
  ) {
    throw new WorktreeError(
      'status_failed',
      `refusing status for ${path}: outside the spawned set of ${options.repoRoot}`,
      1,
    );
  }
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-status',
    turnId: 0,
    operation: 'worktree_status',
  };
  const handle = env.shell.spawn(
    'git',
    ['-C', path, 'status', '--porcelain=v2', '-z', '-b'],
    { provenance },
  );
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    throw new WorktreeError(
      'status_failed',
      `git status failed for ${path} (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  // The worker's porcelain v2 parser (issue #388): NUL-delimited records
  // mean paths round-trip unquoted, renames arrive as new path + old path
  // (never v1's `old -> new` string), and detached HEAD is branch null.
  const parsed = parsePorcelainStatus(done.stdout);
  return {
    path,
    branch: parsed.branch,
    clean: parsed.clean,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    renames: parsed.renames,
  };
}
