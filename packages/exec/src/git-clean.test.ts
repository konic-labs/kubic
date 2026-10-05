// Sync git-cleanliness probe for the composition root (issue #78).
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// the probe shells `git status --porcelain` synchronously. Fail-closed: a
// non-repo, a missing dir, or any git failure reads as NOT clean.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitHeadOf,
  isGitWorktreeClean,
  withDetachedCheckout,
} from './git-clean.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-clean-'));
  roots.push(root);
  return root;
}

function initRepo(dir: string): void {
  const run = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  };
  run(['init']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  run(['add', 'a.txt']);
  // No signing / hooks from the developer's global config.
  run(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init']);
}

describe('isGitWorktreeClean (issue #78)', () => {
  it('reads true on a clean repo', () => {
    const dir = tmpRoot();
    initRepo(dir);
    expect(isGitWorktreeClean(dir)).toBe(true);
  });

  it('reads false on a modified tracked file', () => {
    const dir = tmpRoot();
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(isGitWorktreeClean(dir)).toBe(false);
  });

  it('reads false on an untracked file alone', () => {
    const dir = tmpRoot();
    initRepo(dir);
    writeFileSync(join(dir, 'new.txt'), 'untracked\n');
    expect(isGitWorktreeClean(dir)).toBe(false);
  });

  it('fail-closes on a non-repo dir and a missing path', () => {
    expect(isGitWorktreeClean(tmpRoot())).toBe(false);
    expect(isGitWorktreeClean(join(tmpRoot(), 'no-such-dir'))).toBe(false);
  });
});

describe('withDetachedCheckout (issue #267): the verifier baseline', () => {
  function worktreeCount(dir: string): number {
    return spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter((line) => line.startsWith('worktree ')).length;
  }

  it('runs in a clean checkout of the revision, then removes it', async () => {
    const dir = tmpRoot();
    initRepo(dir);
    const base = gitHeadOf(dir)?.revision as string;
    // The working tree moves on after the base commit.
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    let seen: { content: string; path: string } | undefined;
    const value = await withDetachedCheckout(dir, base, async (checkout) => {
      seen = {
        path: checkout,
        content: readFileSync(join(checkout, 'a.txt'), 'utf8'),
      };
      expect(worktreeCount(dir)).toBe(2);
      return 'done';
    });
    expect(value).toBe('done');
    expect(seen?.content).toBe('hello\n');
    expect(existsSync(seen?.path as string)).toBe(false);
    expect(worktreeCount(dir)).toBe(1);
    // The caller's tree is untouched.
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('changed\n');
  });

  it('removes the checkout even when the callback throws', async () => {
    const dir = tmpRoot();
    initRepo(dir);
    const base = gitHeadOf(dir)?.revision as string;
    await expect(
      withDetachedCheckout(dir, base, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(worktreeCount(dir)).toBe(1);
  });

  it('is null (callback never runs) outside a repo or for an unknown revision', async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return 1;
    };
    expect(await withDetachedCheckout(tmpRoot(), 'HEAD', run)).toBeNull();
    const dir = tmpRoot();
    initRepo(dir);
    expect(await withDetachedCheckout(dir, 'f'.repeat(40), run)).toBeNull();
    expect(ran).toBe(false);
    expect(worktreeCount(dir)).toBe(1);
  });
});

describe('gitHeadOf (issue #383): the §46 trajectory base revision', () => {
  it('names the HEAD sha and the current branch', () => {
    const dir = tmpRoot();
    initRepo(dir);
    spawnSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    expect(gitHeadOf(dir)).toEqual({ revision: sha, branch: 'feature' });
  });

  it('names no branch on a detached HEAD', () => {
    const dir = tmpRoot();
    initRepo(dir);
    spawnSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
    expect(gitHeadOf(dir)?.branch).toBeNull();
    expect(gitHeadOf(dir)?.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is null outside a repository and on a missing path', () => {
    expect(gitHeadOf(tmpRoot())).toBeNull();
    expect(gitHeadOf(join(tmpRoot(), 'no-such-dir'))).toBeNull();
  });
});
