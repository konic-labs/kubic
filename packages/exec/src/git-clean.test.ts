// Sync git-cleanliness probe for the composition root (issue #78).
// `kubic benchmark --workspace worktree` refuses on a dirty tree through
// the eval runner's injected ensureCleanWorktree hook, which is sync — so
// the probe shells `git status --porcelain` synchronously. Fail-closed: a
// non-repo, a missing dir, or any git failure reads as NOT clean.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGitWorktreeClean } from './git-clean.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'git-clean-'));
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
  run(['commit', '-m', 'init']);
}

describe('isGitWorktreeClean (issue #78)', () => {
  it('reads true on a clean repo', () => {
    const dir = tmpRoot();
    initRepo(dir);
    expect(isGitWorktreeClean(dir)).toBe(true);
  });

  it('reads false on a dirty tree (modified + untracked)', () => {
    const dir = tmpRoot();
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'new.txt'), 'untracked\n');
    expect(isGitWorktreeClean(dir)).toBe(false);
  });

  it('fail-closes on a non-repo dir and a missing path', () => {
    expect(isGitWorktreeClean(tmpRoot())).toBe(false);
    expect(isGitWorktreeClean(join(tmpRoot(), 'no-such-dir'))).toBe(false);
  });
});
