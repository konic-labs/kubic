// Worktree status, settle, and post-merge retain (issue #45; §44, §44.1).
// Settle keeps the branch; a merged worktree stays retained by default
// (evidence) — only `kubic clean` disposes. Live status reads through
// the exec Shell seam (`git -C <path> status`, explicit argv).

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import {
  isSpawnedWorktreePath,
  isSpawnedWorktreeShape,
} from './confinement.js';
import { WorktreeError } from './errors.js';
import type { WorktreeEntry } from './list.js';

export interface WorktreeStatus {
  path: string;
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
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
  options?: { sessionId?: string; repoRoot?: string },
): Promise<WorktreeStatus> {
  if (!path.startsWith('/')) {
    throw new WorktreeError(
      'status_failed',
      'worktree path must be absolute',
      1,
    );
  }
  if (!isSpawnedWorktreeShape(path)) {
    throw new WorktreeError(
      'status_failed',
      `refusing status for ${path}: not a spawned worktree under .kubic/wt/`,
      1,
    );
  }
  if (
    options?.repoRoot !== undefined &&
    !isSpawnedWorktreePath(options.repoRoot, path)
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
    ['-C', path, 'status', '--porcelain=v1', '-b'],
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
  let branch = '(unknown)';
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of done.stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      branch = (head.split('...')[0] ?? head).trim() || '(unknown)';
      if (branch.startsWith('No commits yet on ')) {
        branch = branch.slice('No commits yet on '.length);
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();
    if (x === '?' && y === '?') {
      if (file !== '') untracked.push(file);
      continue;
    }
    if (x !== undefined && x !== ' ' && file !== '') staged.push(file);
    if (y !== undefined && y !== ' ' && file !== '') unstaged.push(file);
  }
  return {
    path,
    branch,
    clean:
      staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
  };
}
