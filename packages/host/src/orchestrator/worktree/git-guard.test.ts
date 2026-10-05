// Host-side git guard (issue #363): every host git invocation must run with
// repo hooks and fsmonitor disabled, commits skip verification hooks, and a
// run-start snapshot of .git/config + .git/hooks must surface drift at settle.
// RED first: this file was written before packages/.../git-guard.ts existed.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitGuardSnapshot } from '../../../../exec/src/git-guard-snapshot.js';
import {
  diffGitGuardSnapshots,
  HOST_GIT_COMMIT_EXTRA_ARGS,
  HOST_GIT_CONFIG_ARGS,
  isGitDirTarget,
  withHostGitCommitGuard,
  withHostGitGuard,
} from './git-guard.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-git-guard-'));
  dirs.push(dir);
  return dir;
}

describe('host git argv guard (issue #363)', () => {
  it('prepends the hooksPath + fsmonitor overrides before the subcommand', () => {
    expect(withHostGitGuard(['status', '--porcelain=v1'])).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v1',
    ]);
  });

  it('keeps caller -c identity flags working alongside the guard', () => {
    expect(
      withHostGitGuard([
        '-c',
        'user.name=kubic-worker',
        '-c',
        'user.email=kubic-worker@local',
        'commit',
        '-m',
        'msg',
      ]),
    ).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'user.name=kubic-worker',
      '-c',
      'user.email=kubic-worker@local',
      'commit',
      '-m',
      'msg',
    ]);
  });

  it('exposes the guard as shared constants (one spelling everywhere)', () => {
    expect(HOST_GIT_CONFIG_ARGS).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
    ]);
    expect(HOST_GIT_COMMIT_EXTRA_ARGS).toEqual(['--no-verify']);
  });

  it('commit guard adds --no-verify without duplicating it', () => {
    const once = withHostGitCommitGuard(['commit', '-m', 'msg']);
    expect(once.slice(0, 4)).toEqual([...HOST_GIT_CONFIG_ARGS]);
    expect(once).toContain('--no-verify');
    expect(withHostGitCommitGuard(once)).toEqual(once);
  });

  it('is idempotent: applying the guard twice changes nothing', () => {
    const once = withHostGitGuard(['merge', '--no-ff', 'branch']);
    expect(withHostGitGuard(once)).toEqual(once);
  });
});

describe('drift report over hand-built snapshots (issue #363)', () => {
  // The filesystem snapshot itself is tested in
  // `packages/exec/src/git-guard-snapshot.test.ts`; here the report logic
  // is pinned against explicit before/after pairs.
  const snap = (over: Partial<GitGuardSnapshot>): GitGuardSnapshot => ({
    gitDir: '/repo/.git',
    configHash: 'aaa',
    hooks: {},
    hooksDirMissing: false,
    ...over,
  });

  it('is quiet when nothing changed', () => {
    const before = snap({ hooks: { 'pre-commit': 'h1' } });
    expect(
      diffGitGuardSnapshots(before, snap({ hooks: { 'pre-commit': 'h1' } })),
    ).toEqual([]);
  });

  it('names planted, modified and removed hooks', () => {
    const before = snap({ hooks: { 'pre-commit': 'h1', old: 'h0' } });
    const after = snap({ hooks: { 'pre-commit': 'h2', planted: 'h3' } });
    const text = diffGitGuardSnapshots(before, after).join('\n');
    expect(text).toMatch(/planted.*planted/);
    expect(text).toMatch(/modified.*pre-commit/);
    expect(text).toMatch(/removed.*old/);
  });

  it('reports a moved gitdir instead of diffing across it', () => {
    const lines = diffGitGuardSnapshots(
      snap({}),
      snap({ gitDir: '/elsewhere/.git' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/gitdir moved/);
  });
});

describe('isGitDirTarget (issue #363)', () => {
  const ws = join(tmpdir(), 'repo-test-ws');
  it('matches writes under <workspace>/.git', () => {
    expect(isGitDirTarget(ws, '.git/hooks/pre-commit')).toBe(true);
    expect(isGitDirTarget(ws, '.git/config')).toBe(true);
    expect(isGitDirTarget(ws, '.git')).toBe(true);
    expect(isGitDirTarget(ws, join(ws, '.git', 'hooks', 'x'))).toBe(true);
  });

  it('ignores normal files, .kubic state and escapes', () => {
    expect(isGitDirTarget(ws, 'src/index.ts')).toBe(false);
    expect(isGitDirTarget(ws, '.kubic/journal/x')).toBe(false);
    expect(isGitDirTarget(ws, '.github/workflows/ci.yml')).toBe(false);
    expect(isGitDirTarget(ws, '.git/../src/index.ts')).toBe(false);
    expect(isGitDirTarget(ws, '.gitignore')).toBe(false);
  });
});

describe('guarded git never runs a planted hook (issue #363, real git)', () => {
  it('a failing pre-commit hook blocks the plain commit but not the guarded one', () => {
    const root = scratch();
    const git = (args: readonly string[], cwd: string = root): void => {
      execFileSync('git', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'kubic-test@local']);
    git(['config', 'user.name', 'kubic test']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'file.txt'), 'hello\n');
    git(['add', 'file.txt']);
    // A hook the agent planted mid-run.
    writeFileSync(
      join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho pwned\nexit 1\n',
    );
    execFileSync('chmod', ['+x', join(root, '.git', 'hooks', 'pre-commit')]);
    // Plain commit: the hook runs and fails the commit.
    const plain = spawnSync('git', ['commit', '-m', 'plain'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(plain.status).not.toBe(0);
    expect(`${plain.stdout}\n${plain.stderr}`).toMatch(/pwned/);
    // Guarded commit: the hook never runs, the commit lands.
    const guarded = spawnSync(
      'git',
      withHostGitCommitGuard(['commit', '-m', 'guarded']),
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(`${guarded.stdout}\n${guarded.stderr}`).not.toMatch(/pwned/);
    expect(guarded.status).toBe(0);
  });
});
