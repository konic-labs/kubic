// Worktree list (issue #45; §44, §85 mirror).
// `git worktree list --porcelain` through the exec Shell seam with
// explicit argv (never shell-interpolated); faux seam in tests.

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { notARepoError, WorktreeError } from './errors.js';
import { parseBranchAgent } from './naming.js';

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const flush = (): void => {
    if (current !== null) entries.push(current);
    current = null;
  };
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        bare: false,
        detached: false,
      };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

// Retained `kubic/<agent>` branches (issue #92): the branch half of the
// spawned set. Enumeration is namespace-only — anything outside the
// `kubic/` prefix is never even considered for disposal.
export async function listSpawnedBranches(
  env: ExecutionEnv,
  options?: { sessionId?: string },
): Promise<string[]> {
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-branch-list',
    turnId: 0,
    operation: 'worktree_branch_list',
  };
  const handle = env.shell.spawn(
    'git',
    ['branch', '--list', 'kubic/*', '--format=%(refname:short)'],
    { provenance },
  );
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    if (/not a git repository/i.test(done.stderr)) {
      throw notARepoError(env.cwd);
    }
    throw new WorktreeError(
      'list_failed',
      `git branch --list kubic/* failed (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  const branches: string[] = [];
  for (const raw of done.stdout.split('\n')) {
    const branch = raw.trim();
    if (branch === '' || parseBranchAgent(branch) === null) continue;
    branches.push(branch);
  }
  return branches;
}

export async function listWorktrees(
  env: ExecutionEnv,
  options?: { sessionId?: string },
): Promise<WorktreeEntry[]> {
  const provenance: Provenance = {
    sessionId: options?.sessionId ?? 'cli',
    agentId: 'manager',
    toolCallId: 'worktree-list',
    turnId: 0,
    operation: 'worktree_list',
  };
  const handle = env.shell.spawn('git', ['worktree', 'list', '--porcelain'], {
    provenance,
  });
  const done = await handle.wait();
  if (done.exitCode !== 0) {
    if (/not a git repository/i.test(done.stderr)) {
      throw notARepoError(env.cwd);
    }
    throw new WorktreeError(
      'list_failed',
      `git worktree list failed (exit ${done.exitCode}): ${done.stderr.trim().slice(0, 200)}`,
      1,
    );
  }
  return parseWorktreePorcelain(done.stdout);
}
