// Sync git-cleanliness probe for the composition root.
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// this probe shells `git status --porcelain` synchronously instead of
// going through the async ExecutionEnv shell. Only packages/exec may
// spawn processes (I/O confinement); fail-closed: a non-repo, a
// missing dir, or any git failure reads as NOT clean, so a benchmark is
// refused rather than scored on an unverified tree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The trajectory's base revision: HEAD's sha and the
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

// One bounded git call in `repoDir`; true on exit 0. A spawn failure (git
// missing) reports a non-zero status, so it is "not ok" too.
function gitOk(repoDir: string, args: string[]): boolean {
  try {
    return (
      spawnSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

const BASELINE_TMP_PREFIX = 'kubic-verify-base-';
const BASELINE_CHECKOUT_NAME = 'base';

// A throwaway checkout of `revision` for the verifier's baseline: `git worktree
// add --detach` into a fresh temp dir, `fn` runs there, and the worktree is
// removed (and pruned) whatever `fn` does — the repo's `git worktree list` is
// back to what it was. Null, with `fn` never run, when `repoDir` is not a
// repository or the revision does not resolve: the caller then simply has no
// baseline.
export async function withDetachedCheckout<T>(
  repoDir: string,
  revision: string,
  fn: (checkout: string) => Promise<T>,
): Promise<T | null> {
  const parent = mkdtempSync(join(tmpdir(), BASELINE_TMP_PREFIX));
  const checkout = join(parent, BASELINE_CHECKOUT_NAME);
  try {
    if (
      !gitOk(repoDir, [
        'worktree',
        'add',
        '--detach',
        '--quiet',
        checkout,
        revision,
      ])
    ) {
      return null;
    }
    return await fn(checkout);
  } finally {
    gitOk(repoDir, ['worktree', 'remove', '--force', checkout]);
    gitOk(repoDir, ['worktree', 'prune']);
    rmSync(parent, { recursive: true, force: true });
  }
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
