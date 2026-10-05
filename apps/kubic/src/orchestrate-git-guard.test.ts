// Every host-side commit carries the commit guard (issue #428):
// withHostGitCommitGuard was dead in production while orchestrate-run
// hand-rolled `--no-verify` in two argument lists. Commits now route
// through hostGitArgs, and the source scans below fail if a commit path
// ever bypasses the helper again.
//
// RED first: hostGitArgs did not exist, and the hand-rolled literals were
// still in orchestrate-run.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  withHostGitCommitGuard,
  withHostGitGuard,
} from '../../../packages/host/src/orchestrator/worktree/git-guard.js';
import { hostGitArgs } from './orchestrate-run.js';

const ORCHESTRATE_RUN = join(
  dirname(fileURLToPath(import.meta.url)),
  'orchestrate-run.ts',
);

function source(): string {
  const text = readFileSync(ORCHESTRATE_RUN, 'utf8');
  expect(text.length).toBeGreaterThan(0);
  return text;
}

describe('host commits always carry the commit guard (issue #428)', () => {
  it('routes commit argv through withHostGitCommitGuard', () => {
    const workerCommit = [
      '-c',
      'user.name=kubic-worker',
      '-c',
      'user.email=kubic-worker@local',
      'commit',
      '-m',
      'worker a: prompt',
    ];
    expect(hostGitArgs(workerCommit)).toEqual(
      withHostGitCommitGuard(workerCommit),
    );
    expect(hostGitArgs(workerCommit)).toContain('--no-verify');
    expect(hostGitArgs(['commit', '-m', 'bare'])).toEqual(
      withHostGitCommitGuard(['commit', '-m', 'bare']),
    );
  });

  it('routes anything else through the plain guard', () => {
    expect(hostGitArgs(['status', '--porcelain=v2'])).toEqual(
      withHostGitGuard(['status', '--porcelain=v2']),
    );
    expect(hostGitArgs(['merge', '--no-ff', 'branch'])).toEqual(
      withHostGitGuard(['merge', '--no-ff', 'branch']),
    );
  });

  it('no hand-rolled --no-verify remains in the run', () => {
    expect(source()).not.toMatch(/'--no-verify'/);
  });

  it('git spawns only through the guarded runGit', () => {
    const text = source();
    const spawns = [...text.matchAll(/\.spawn\(\s*'git'/g)];
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.length).toBe(1);
  });
});
