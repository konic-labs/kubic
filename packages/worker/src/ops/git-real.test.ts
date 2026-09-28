// Issue #193, prod path: every git_* op end to end against real git in a
// throwaway repository. The fake-execution suites pin argv and shape; these
// pin what real git actually prints — renames, copies, quoted/non-ASCII
// paths, MM/RM, detached HEAD, unborn branches, ahead/behind against a
// local bare remote, diff variants, stage, commit, checkpoint (subject and
// apply), log, show, and branch list/create.
//
// Hermetic: system git config is off (GIT_CONFIG_NOSYSTEM=1 is allowlisted
// into the ops' spawn env, packages/exec/src/env.ts, and stubbed into the
// process here), and global config has nowhere to live — HOME and
// XDG_CONFIG_HOME are stubbed to empty per-repo directories, so op-spawned
// git sees exactly the repo-local config this file writes, never the
// host's. The git driven directly gets the same two directories plus an
// explicit GIT_CONFIG_GLOBAL override, so an ambient config path cannot
// leak. Every scratch directory is removed in afterEach; nothing touches
// the network.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import {
  callOperation,
  type OperationName,
  type OperationResults,
} from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

interface Repo {
  // Scratch parent holding home/ (empty HOME) and repo/ (the work tree).
  parent: string;
  // Repository root, realpath-resolved: macOS /var is a symlink and git
  // reports the resolved toplevel.
  path: string;
  // Empty HOME for this repo's git, so no developer config leaks in. It
  // lives outside the work tree or it would show up as untracked.
  home: string;
  // Empty XDG_CONFIG_HOME, same purpose for $XDG_CONFIG_HOME/git/config.
  xdg: string;
}

const scratchDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(repo: Repo, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo.path,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: repo.home,
      XDG_CONFIG_HOME: repo.xdg,
      GIT_CONFIG_NOSYSTEM: '1',
      // No ambient GIT_CONFIG_GLOBAL either: a missing path is no config.
      GIT_CONFIG_GLOBAL: join(repo.home, 'no-global-config'),
    },
  });
}

function scratchRepo(): Repo {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kubic-git-real-')));
  scratchDirs.push(parent);
  const home = join(parent, 'home');
  const xdg = join(parent, 'xdg');
  const path = join(parent, 'repo');
  mkdirSync(home);
  mkdirSync(xdg);
  mkdirSync(path);
  // HOME, XDG_CONFIG_HOME and GIT_CONFIG_NOSYSTEM are allowlisted into the
  // ops' spawn env, so stubbing them keeps op-spawned git on the same
  // config-free view as git().
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const repo: Repo = { parent, path, home, xdg };
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'kubic-test@local']);
  git(repo, ['config', 'user.name', 'kubic test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

function commitFile(repo: Repo, name: string, content: string): void {
  writeFileSync(join(repo.path, name), content);
  git(repo, ['add', '--', name]);
  git(repo, ['commit', '-q', '-m', `add ${name}`]);
}

function ctx(dir: string): OpContext {
  return { env: new NodeExecutionEnv(dir), sessionId: 's1', agentId: 'a1' };
}

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

async function ok<N extends OperationName>(
  name: N,
  args: unknown,
  dir: string,
  id: string,
): Promise<OperationResults[N]> {
  const out = await callOperation(name, args, inv(id), ctx(dir));
  if (!out.ok) throw new Error(`${name} failed: ${out.error.message}`);
  return out.result;
}

describe('git_status over real git (issue #193)', () => {
  it('reports a renamed file by its new path with the old path', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'old name.txt', 'one\n');
    git(repo, ['mv', 'old name.txt', 'new name.txt']);

    const status = await ok('git_status', {}, repo.path, 'st-rename');
    expect(status.staged).toContain('new name.txt');
    expect(status.staged).not.toContain('old name.txt');
    expect(status.staged).not.toContain('old name.txt -> new name.txt');
    expect(status.renames).toContainEqual({
      path: 'new name.txt',
      oldPath: 'old name.txt',
      staged: true,
    });
  });

  it('reports a rename that is also modified in the worktree (RM)', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'old.txt', 'one\n');
    git(repo, ['mv', 'old.txt', 'new.txt']);
    writeFileSync(join(repo.path, 'new.txt'), 'one\ntwo\n');

    const status = await ok('git_status', {}, repo.path, 'st-rm');
    expect(status.staged).toContain('new.txt');
    expect(status.unstaged).toContain('new.txt');
    expect(status.renames).toContainEqual({
      path: 'new.txt',
      oldPath: 'old.txt',
      staged: true,
    });
  });

  it('reports a copy with the path it came from', async () => {
    const repo = scratchRepo();
    git(repo, ['config', 'status.renames', 'copies']);
    commitFile(repo, 'source.txt', 'shared content\n');
    git(repo, ['mv', 'source.txt', 'copy.txt']);
    writeFileSync(join(repo.path, 'source.txt'), 'shared content\nplus more\n');
    git(repo, ['add', '--', 'source.txt']);

    const status = await ok('git_status', {}, repo.path, 'st-copy');
    expect(status.staged).toContain('copy.txt');
    expect(status.renames).toContainEqual({
      path: 'copy.txt',
      oldPath: 'source.txt',
      staged: true,
    });
  });

  it('returns quoted and non-ASCII paths unquoted', async () => {
    const repo = scratchRepo();
    const names = ['café 😀.txt', 'tab\tname.txt', 'line\nbreak.txt'];
    for (const name of names) {
      writeFileSync(join(repo.path, name), 'untracked\n');
    }

    const status = await ok('git_status', {}, repo.path, 'st-quoted');
    expect(status.untracked).toHaveLength(names.length);
    for (const name of names) expect(status.untracked).toContain(name);
  });

  it('reports a file modified on both sides (MM) and no renames', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'both.txt', 'one\n');
    writeFileSync(join(repo.path, 'both.txt'), 'one\nstaged\n');
    git(repo, ['add', '--', 'both.txt']);
    writeFileSync(join(repo.path, 'both.txt'), 'one\nstaged\nworktree\n');

    const status = await ok('git_status', {}, repo.path, 'st-mm');
    expect(status.staged).toContain('both.txt');
    expect(status.unstaged).toContain('both.txt');
    expect(status.renames).toEqual([]);
  });

  it('reports an unborn branch by name, clean', async () => {
    const repo = scratchRepo();

    const status = await ok('git_status', {}, repo.path, 'st-unborn');
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.clean).toBe(true);
  });

  it('reports a detached HEAD as null, never a branch name', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');
    git(repo, ['checkout', '-q', '--detach', 'HEAD']);

    const status = await ok('git_status', {}, repo.path, 'st-detached');
    expect(status.branch).toBeNull();
    expect(status.clean).toBe(true);
  });

  it('tracks ahead/behind against a local bare remote', async () => {
    const repo = scratchRepo();
    const bare = join(repo.parent, 'remote.git');
    git(repo, ['init', '-q', '--bare', '-b', 'main', bare]);
    commitFile(repo, 'a.txt', 'a\n');
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);

    const even = await ok('git_status', {}, repo.path, 'st-even');
    expect(even.ahead).toBe(0);
    expect(even.behind).toBe(0);

    writeFileSync(join(repo.path, 'a.txt'), 'a\nb\n');
    git(repo, ['commit', '-qam', 'v2']);
    const ahead = await ok('git_status', {}, repo.path, 'st-ahead');
    expect(ahead.ahead).toBe(1);
    expect(ahead.behind).toBe(0);

    // Push the local commit, then wind the branch back: the remote is now
    // one ahead of the checked-out commit.
    git(repo, ['push', '-q', 'origin', 'main']);
    git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    const behind = await ok('git_status', {}, repo.path, 'st-behind');
    expect(behind.ahead).toBe(0);
    expect(behind.behind).toBe(1);
  });
});

describe('git read/effect ops over real git (issue #193)', () => {
  it('scopes diff to unstaged, staged, path and range', async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a1\n');
    writeFileSync(join(repo.path, 'b.txt'), 'b1\n');
    git(repo, ['add', '--', 'a.txt', 'b.txt']);
    git(repo, ['commit', '-q', '-m', 'v1']);
    writeFileSync(join(repo.path, 'a.txt'), 'a2\n');
    git(repo, ['add', '--', 'a.txt']);
    writeFileSync(join(repo.path, 'b.txt'), 'b2\n');

    const unstaged = await ok('git_diff', {}, repo.path, 'diff-worktree');
    expect(unstaged.diff).toContain('b.txt');
    expect(unstaged.diff).not.toContain('a.txt');

    const staged = await ok(
      'git_diff',
      { staged: true },
      repo.path,
      'diff-staged',
    );
    expect(staged.diff).toContain('a.txt');
    expect(staged.diff).not.toContain('b.txt');

    const scoped = await ok(
      'git_diff',
      { path: 'b.txt' },
      repo.path,
      'diff-path',
    );
    expect(scoped.diff).toContain('b.txt');
    expect(scoped.diff).not.toContain('a.txt');

    git(repo, ['commit', '-q', '-m', 'v2']);
    const ranged = await ok(
      'git_diff',
      { range: 'HEAD~1..HEAD' },
      repo.path,
      'diff-range',
    );
    expect(ranged.diff).toContain('+a2');
    expect(ranged.diff).not.toContain('b.txt');
  });

  it('stages only the named paths, leaving an untracked sibling alone', async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo.path, 'staged.txt'), 's\n');
    writeFileSync(join(repo.path, 'sibling.txt'), 'u\n');

    const staged = await ok(
      'git_stage',
      { paths: ['staged.txt'] },
      repo.path,
      'stage',
    );
    expect(staged.staged).toEqual(['staged.txt']);

    const status = await ok('git_status', {}, repo.path, 'stage-status');
    expect(status.staged).toEqual(['staged.txt']);
    expect(status.untracked).toEqual(['sibling.txt']);
  });

  it('commits staged files and reports the sha plus the file list', async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a\n');
    writeFileSync(join(repo.path, 'b.txt'), 'b\n');
    writeFileSync(join(repo.path, 'untracked.txt'), 'u\n');
    await ok(
      'git_stage',
      { paths: ['a.txt', 'b.txt'] },
      repo.path,
      'commit-stage',
    );

    const committed = await ok(
      'git_commit',
      { message: 'feat: add files' },
      repo.path,
      'commit',
    );
    expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.files.sort()).toEqual(['a.txt', 'b.txt']);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(committed.sha);

    const log = await ok('git_log', { max: 1 }, repo.path, 'commit-log');
    expect(log.entries[0]?.message).toBe('feat: add files');
  });

  it('returns commit file paths verbatim (non-ASCII and newline names)', async () => {
    const repo = scratchRepo();
    const names = ['café 😀.txt', 'line\nbreak.txt'];
    for (const name of names) writeFileSync(join(repo.path, name), 'x\n');
    await ok('git_stage', { paths: names }, repo.path, 'commit-files-stage');

    const committed = await ok(
      'git_commit',
      { message: 'unicode files' },
      repo.path,
      'commit-files',
    );
    expect(committed.files.sort()).toEqual([...names].sort());
  });

  it('creates a restorable checkpoint whose stash subject carries the message', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    writeFileSync(join(repo.path, 'a.txt'), 'one\ntwo\n');

    const message = 'before risky edit';
    const checkpoint = await ok(
      'git_checkpoint',
      { message },
      repo.path,
      'checkpoint',
    );
    expect(checkpoint.sha).toMatch(/^[0-9a-f]{40}$/);
    // git prefixes a stash subject with `On <branch>: `; the given message
    // must be the rest of it, never a stray `-m` argv artifact.
    const subject = git(repo, [
      'log',
      '-1',
      '--format=%s',
      checkpoint.sha,
    ]).trim();
    expect(subject).toBe(`On main: ${message}`);

    // The checkpoint left the tree alone and restores without a stash ref.
    git(repo, ['checkout', '-q', '--', 'a.txt']);
    git(repo, ['stash', 'apply', '-q', checkpoint.sha]);
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('lists branches and creates a new one', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');

    const listed = await ok('git_branch', {}, repo.path, 'branch-list');
    expect(listed.branches).toContain('main');

    const created = await ok(
      'git_branch',
      { create: 'feature/x' },
      repo.path,
      'branch-create',
    );
    expect(created.created).toBe('feature/x');

    const relisted = await ok('git_branch', {}, repo.path, 'branch-list-2');
    expect(relisted.branches).toContain('feature/x');
  });

  it('returns the patch for a ref', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    writeFileSync(join(repo.path, 'a.txt'), 'one\ntwo\n');
    git(repo, ['commit', '-qam', 'v2']);

    const shown = await ok('git_show', { ref: 'HEAD' }, repo.path, 'show');
    expect(shown.patch).toContain('+two');
  });
});
