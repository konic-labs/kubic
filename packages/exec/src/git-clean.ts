// Sync git-cleanliness probe for the composition root (issue #78).
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// this probe shells `git status --porcelain` synchronously instead of
// going through the async ExecutionEnv shell. Only packages/exec may
// spawn processes (I/O confinement, §9); fail-closed: a non-repo, a
// missing dir, or any git failure reads as NOT clean, so a benchmark is
// refused rather than scored on an unverified tree.
import { spawnSync } from 'node:child_process';

export function isGitWorktreeClean(worktree: string): boolean {
  try {
    const result = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    if (result.error !== undefined || result.status !== 0) return false;
    return result.stdout.trim() === '';
  } catch {
    return false;
  }
}
