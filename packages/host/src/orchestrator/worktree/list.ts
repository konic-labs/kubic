// Worktree list (issue #45; §44, §85 mirror).
// `git worktree list --porcelain` through the exec Shell seam with
// explicit argv (never shell-interpolated); faux seam in tests.

import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { notARepoError, WorktreeError } from './errors.js';

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
