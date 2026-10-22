// Sync git-cleanliness probe for the composition root.
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// the probe shells `git status --porcelain` synchronously. Fail-closed: a
// non-repo, a missing dir, or any git failure reads as NOT clean.
//
// Real git in sandboxed throwaway repos: the repo setup runs
// through the shared sandbox's scrubbed env, and the sandbox is activated
// into process.env while the probe (which spawns git on the inherited
// environment) runs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import {
  gitHeadOf,
  isGitWorktreeClean,
  withDetachedCheckout,
} from './git-clean.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from './test-support/git-sandbox.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

// Activated: isGitWorktreeClean / withDetachedCheckout / gitHeadOf spawn git
// on the inherited environment, so process.env itself must be the sandbox's
// while they run; disposeAllGitSandboxes restores it afterwards.
function initRepo(): GitSandbox {
  const repo = createGitSandbox({
    prefix: 'git-clean-',
    injectProcessEnv: true,
  });
  writeFileSync(join(repo.path, 'a.txt'), 'hello\n');
  repo.git(['add', 'a.txt']);
  // No signing / hooks from the developer's global config (sandbox-local
  // config pins both; --no-verify is belt and braces).
  repo.git(['commit', '--no-verify', '-m', 'init']);
  return repo;
}

describe('isGitWorktreeClean', () => {
  it('reads true on a clean repo', () => {
    const repo = initRepo();
    expect(isGitWorktreeClean(repo.path)).toBe(true);
  });

  it('reads false on a modified tracked file', () => {
    const repo = initRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'changed\n');
    expect(isGitWorktreeClean(repo.path)).toBe(false);
  });

  it('reads false on an untracked file alone', () => {
    const repo = initRepo();
    writeFileSync(join(repo.path, 'new.txt'), 'untracked\n');
    expect(isGitWorktreeClean(repo.path)).toBe(false);
  });

  it('fail-closes on a non-repo dir and a missing path', () => {
    expect(isGitWorktreeClean(tempDir('git-clean-'))).toBe(false);
    expect(isGitWorktreeClean(join(tempDir('git-clean-'), 'no-such-dir'))).toBe(
      false,
    );
  });
});

describe('withDetachedCheckout: the verifier baseline', () => {
  function worktreeCount(repo: GitSandbox): number {
    return repo
      .git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length;
  }

  it('runs in a clean checkout of the revision, then removes it', async () => {
    const repo = initRepo();
    const base = gitHeadOf(repo.path)?.revision as string;
    // The working tree moves on after the base commit.
    writeFileSync(join(repo.path, 'a.txt'), 'changed\n');
    let seen: { content: string; path: string } | undefined;
    const value = await withDetachedCheckout(
      repo.path,
      base,
      async (checkout) => {
        seen = {
          path: checkout,
          content: readFileSync(join(checkout, 'a.txt'), 'utf8'),
        };
        expect(worktreeCount(repo)).toBe(2);
        return 'done';
      },
    );
    expect(value).toBe('done');
    expect(seen?.content).toBe('hello\n');
    expect(existsSync(seen?.path as string)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
    // The caller's tree is untouched.
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('changed\n');
  });

  it('removes the checkout even when the callback throws', async () => {
    const repo = initRepo();
    const base = gitHeadOf(repo.path)?.revision as string;
    await expect(
      withDetachedCheckout(repo.path, base, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('is null (callback never runs) outside a repo or for an unknown revision', async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return 1;
    };
    expect(
      await withDetachedCheckout(tempDir('git-clean-'), 'HEAD', run),
    ).toBeNull();
    const repo = initRepo();
    expect(
      await withDetachedCheckout(repo.path, 'f'.repeat(40), run),
    ).toBeNull();
    expect(ran).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });
});

describe('gitHeadOf: the trajectory base revision', () => {
  it('names the HEAD sha and the current branch', () => {
    const repo = initRepo();
    repo.git(['checkout', '-q', '-b', 'feature']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    expect(gitHeadOf(repo.path)).toEqual({ revision: sha, branch: 'feature' });
  });

  it('names no branch on a detached HEAD', () => {
    const repo = initRepo();
    repo.git(['checkout', '-q', '--detach']);
    expect(gitHeadOf(repo.path)?.branch).toBeNull();
    expect(gitHeadOf(repo.path)?.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is null outside a repository and on a missing path', () => {
    expect(gitHeadOf(tempDir('git-clean-'))).toBeNull();
    expect(gitHeadOf(join(tempDir('git-clean-'), 'no-such-dir'))).toBeNull();
  });
});
