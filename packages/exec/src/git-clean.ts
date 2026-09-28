// Sync git-cleanliness probe for the composition root (issue #78).
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// this probe shells `git status --porcelain` synchronously instead of
// going through the async ExecutionEnv shell. Only packages/exec may
// spawn processes (I/O confinement, §9); fail-closed: a non-repo, a
// missing dir, or any git failure reads as NOT clean, so a benchmark is
// refused rather than scored on an unverified tree.
import { spawnSync } from 'node:child_process';

function gitOut(dir: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    const value = result.stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

// The §46 trajectory's base revision (issue #383): HEAD's sha and the
// branch it is on (null when detached). Null outside a repository — the
// caller records that explicitly instead of inventing a revision.
export function gitHeadOf(
  dir: string,
): { revision: string; branch: string | null } | null {
  const revision = gitOut(dir, ['rev-parse', 'HEAD']);
  if (revision === null) return null;
  const branch = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { revision, branch: branch === 'HEAD' ? null : branch };
}

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
