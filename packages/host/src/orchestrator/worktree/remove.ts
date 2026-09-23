// Worktree remove (issue #45; §44).
// `git worktree remove <path>` through the exec Shell seam with explicit
// argv (never shell-interpolated). The branch is never deleted here:
// removal disposes the checkout, the `kubic/<agent>` branch stays.

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { WorktreeError } from './errors.js';
import { branchForAgent } from './naming.js';

export interface RemoveWorktreeResult {
  path: string;
  removed: true;
  branchKept: true;
  branch: string | null;
}

function branchForPath(path: string): string | null {
  const agent = path.split('/').pop() ?? '';
  try {
    return branchForAgent(agent);
  } catch {
    return null;
  }
}

export async function removeWorktree(
  env: ExecutionEnv,
  path: string,
  options?: { force?: boolean; sessionId?: string },
): Promise<RemoveWorktreeResult> {
  if (!path.startsWith('/')) {
    throw new WorktreeError(
      'remove_failed',
      'worktree path must be absolute',
      1,
    );
  }
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
