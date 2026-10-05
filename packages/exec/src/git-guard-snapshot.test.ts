// Filesystem snapshot for the host git guard (issue #363).
// RED first: written before packages/exec/src/git-guard-snapshot.ts existed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitDir, snapshotGitGuard } from './git-guard-snapshot.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-git-guard-snap-'));
  dirs.push(dir);
  return dir;
}

describe('git guard snapshot (issue #363)', () => {
  it('snapshots .git/config and .git/hooks, and reports a planted hook', () => {
    const root = scratch();
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    const before = snapshotGitGuard(root);
    writeFileSync(
      join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
    );
    const after = snapshotGitGuard(root);
    expect(after.hooks['pre-commit']).toBeDefined();
    expect(before.hooks['pre-commit']).toBeUndefined();
    expect(after.configHash).toBe(before.configHash);
  });

  it('reports a .git/config change during a run', () => {
    const root = scratch();
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    const before = snapshotGitGuard(root);
    writeFileSync(
      join(root, '.git', 'config'),
      '[core]\n\thooksPath = /tmp/evil-hooks\n',
    );
    const after = snapshotGitGuard(root);
    expect(after.configHash).toBeDefined();
    expect(after.configHash).not.toBe(before.configHash);
  });

  it('is quiet when nothing changed', () => {
    const root = scratch();
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    const before = snapshotGitGuard(root);
    expect(snapshotGitGuard(root)).toEqual(before);
  });

  it('never throws on a repo without .git', () => {
    const root = scratch();
    const snap = snapshotGitGuard(root);
    expect(snap.configHash).toBeUndefined();
    expect(snap.hooksDirMissing).toBe(true);
    expect(snap.hooks).toEqual({});
  });

  it('follows a .git pointer file (linked worktree gitdir)', () => {
    const root = scratch();
    const gitdir = join(root, 'common', 'worktrees', 'wt1');
    mkdirSync(join(gitdir, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.git'),
      `gitdir: ${join('common', 'worktrees', 'wt1')}\n`,
    );
    writeFileSync(join(gitdir, 'config'), '[core]\n');
    expect(resolveGitDir(root)).toBe(gitdir);
    const before = snapshotGitGuard(root);
    expect(before.gitDir).toBe(gitdir);
    writeFileSync(join(gitdir, 'hooks', 'post-checkout'), '#!/bin/sh\n');
    const after = snapshotGitGuard(root);
    expect(after.hooks['post-checkout']).toBeDefined();
    expect(before.hooks['post-checkout']).toBeUndefined();
  });
});
