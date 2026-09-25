// Worktree remove (issue #45; §44).
// `git worktree remove <path>` through the exec Shell seam with explicit
// argv (never shell-interpolated). The branch is never deleted here:
// removal disposes the checkout, the `kubic/<agent>` branch stays.

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import {
  isSpawnedWorktreePath,
  isSpawnedWorktreeShape,
} from './confinement.js';
import { WorktreeError } from './errors.js';
import { branchForAgent, parseBranchAgent } from './naming.js';

export interface RemoveWorktreeResult {
  path: string;
  removed: true;
  branchKept: true;
  branch: string | null;
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  sessionId?: string;
  repoRoot?: string;
}

function branchForPath(path: string): string | null {
  const agent = path.split('/').pop() ?? '';
  try {
    return branchForAgent(agent);
  } catch {
    return null;
  }
}

function assertSpawnedPath(path: string, repoRoot: string | undefined): void {
  if (!isSpawnedWorktreeShape(path)) {
    throw new WorktreeError(
      'remove_failed',
      `refusing to remove ${path}: not a spawned worktree under .kubic/wt/`,
      1,
    );
  }
  if (repoRoot !== undefined && !isSpawnedWorktreePath(repoRoot, path)) {
    throw new WorktreeError(
      'remove_failed',
      `refusing to remove ${path}: outside the spawned set of ${repoRoot}`,
      1,
    );
  }
}

export async function removeWorktree(
  env: ExecutionEnv,
  path: string,
  options?: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  if (!path.startsWith('/')) {
    throw new WorktreeError(
      'remove_failed',
      'worktree path must be absolute',
      1,
    );
  }
  assertSpawnedPath(path, options?.repoRoot);
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-remove',
    turnId: 0,
    operation: 'worktree_remove',
  };
  const argv = ['worktree', 'remove', path];
  if (options?.force === true) argv.push('--force');
  const handle = env.shell.spawn('git', argv, { provenance });
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    throw new WorktreeError(
      'remove_failed',
      `git worktree remove ${path} failed (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  return { path, removed: true, branchKept: true, branch: branchForPath(path) };
}

// Branch half of disposal (issue #92): a spawned worktree's `kubic/<agent>`
// branch is deleted only through here, and only after the worktree checkout
// is gone (git refuses to delete a branch still checked out). Namespace
// confinement mirrors the worktree side: a name outside `kubic/` is refused
// before any git call.
export async function deleteSpawnedBranch(
  env: ExecutionEnv,
  branch: string,
  options?: { sessionId?: string },
): Promise<{ branch: string; deleted: true }> {
  if (parseBranchAgent(branch) === null) {
    throw new WorktreeError(
      'remove_failed',
      `refusing to delete ${branch}: not a kubic/<agent> branch`,
      1,
    );
  }
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-branch-delete',
    turnId: 0,
    operation: 'worktree_branch_delete',
  };
  const handle = env.shell.spawn('git', ['branch', '-D', branch], {
    provenance,
  });
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    throw new WorktreeError(
      'remove_failed',
      `git branch -D ${branch} failed (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  return { branch, deleted: true };
}

// Stale worktree admin records (issue #92): a retained worktree whose
// directory was already deleted by hand leaves a `.git/worktrees` entry
// behind, which is why a second `kubic clean` must be able to prune.
export async function pruneWorktrees(
  env: ExecutionEnv,
  options?: { sessionId?: string },
): Promise<{ pruned: true }> {
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-prune',
    turnId: 0,
    operation: 'worktree_prune',
  };
  const handle = env.shell.spawn('git', ['worktree', 'prune'], { provenance });
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    throw new WorktreeError(
      'remove_failed',
      `git worktree prune failed (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  return { pruned: true };
}
