// Prod path: every git_* op end to end against real git in a
// throwaway repository. The fake-execution suites pin argv and shape; these
// pin what real git actually prints — renames, copies, quoted/non-ASCII
// paths, MM/RM, detached HEAD, unborn branches, ahead/behind against a
// local bare remote, diff variants, stage, commit, checkpoint (subject and
// apply), log, show, and branch list/create.
//
// Hermetic: every scratch repo is a shared git sandbox —
// system git config is off, global config has nowhere to live, and the
// ambient GIT_DIR family is scrubbed — so op-spawned git (via
// NodeExecutionEnv on the inherited environment) sees exactly the
// repo-local config this file writes, never the host's. The sandbox is
// activated into process.env per repo; every scratch directory is removed
// in afterEach; nothing touches the network.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../exec/src/test-support/git-sandbox.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import {
  callOperation,
  type OperationName,
  type OperationResults,
} from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

// Activated: the ops under test spawn git through NodeExecutionEnv on the
// inherited environment, so process.env itself must be the sandbox's while
// the test runs; disposeAllGitSandboxes restores it afterwards.
function scratchRepo(): GitSandbox {
  return createGitSandbox({
    prefix: 'kubic-git-real-',
    injectProcessEnv: true,
  });
}

function commitFile(repo: GitSandbox, name: string, content: string): void {
  writeFileSync(join(repo.path, name), content);
  repo.git(['add', '--', name]);
  repo.git(['commit', '-q', '-m', `add ${name}`]);
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

describe('git_status over real git', () => {
  it('reports a renamed file by its new path with the old path', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'old name.txt', 'one\n');
    repo.git(['mv', 'old name.txt', 'new name.txt']);

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
    repo.git(['mv', 'old.txt', 'new.txt']);
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
    repo.git(['config', 'status.renames', 'copies']);
    commitFile(repo, 'source.txt', 'shared content\n');
    repo.git(['mv', 'source.txt', 'copy.txt']);
    writeFileSync(join(repo.path, 'source.txt'), 'shared content\nplus more\n');
    repo.git(['add', '--', 'source.txt']);

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
    repo.git(['add', '--', 'both.txt']);
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
    repo.git(['checkout', '-q', '--detach', 'HEAD']);

    const status = await ok('git_status', {}, repo.path, 'st-detached');
    expect(status.branch).toBeNull();
    expect(status.clean).toBe(true);
  });

  it('tracks ahead/behind against a local bare remote', async () => {
    const repo = scratchRepo();
    const bare = join(repo.parent, 'remote.git');
    repo.git(['init', '-q', '--bare', '-b', 'main', bare]);
    commitFile(repo, 'a.txt', 'a\n');
    repo.git(['remote', 'add', 'origin', bare]);
    repo.git(['push', '-q', '-u', 'origin', 'main']);

    const even = await ok('git_status', {}, repo.path, 'st-even');
    expect(even.ahead).toBe(0);
    expect(even.behind).toBe(0);

    writeFileSync(join(repo.path, 'a.txt'), 'a\nb\n');
    repo.git(['commit', '-qam', 'v2']);
    const ahead = await ok('git_status', {}, repo.path, 'st-ahead');
    expect(ahead.ahead).toBe(1);
    expect(ahead.behind).toBe(0);

    // Push the local commit, then wind the branch back: the remote is now
    // one ahead of the checked-out commit.
    repo.git(['push', '-q', 'origin', 'main']);
    repo.git(['reset', '-q', '--hard', 'HEAD~1']);
    const behind = await ok('git_status', {}, repo.path, 'st-behind');
    expect(behind.ahead).toBe(0);
    expect(behind.behind).toBe(1);
  });
});

describe('git read/effect ops over real git', () => {
  it('scopes diff to unstaged, staged, path and range', async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a1\n');
    writeFileSync(join(repo.path, 'b.txt'), 'b1\n');
    repo.git(['add', '--', 'a.txt', 'b.txt']);
    repo.git(['commit', '-q', '-m', 'v1']);
    writeFileSync(join(repo.path, 'a.txt'), 'a2\n');
    repo.git(['add', '--', 'a.txt']);
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

    repo.git(['commit', '-q', '-m', 'v2']);
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
    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(committed.sha);

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
    const subject = repo
      .git(['log', '-1', '--format=%s', checkpoint.sha])
      .trim();
    expect(subject).toBe(`On main: ${message}`);

    // The checkpoint left the tree alone and restores without a stash ref.
    repo.git(['checkout', '-q', '--', 'a.txt']);
    repo.git(['stash', 'apply', '-q', checkpoint.sha]);
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

  it('lists only real branches on a detached HEAD, never the "(HEAD detached at …)" pseudo-entry', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');
    repo.git(['branch', 'feature/x']);
    repo.git(['checkout', '-q', '--detach', 'HEAD']);

    const listed = await ok('git_branch', {}, repo.path, 'branch-detached');
    expect(listed.branches).toEqual(['feature/x', 'main']);
  });

  it('lists a branch by its full name even when a tag shares it', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');
    repo.git(['tag', 'main']);

    const listed = await ok('git_branch', {}, repo.path, 'branch-tag-clash');
    expect(listed.branches).toEqual(['main']);
  });

  it('lists nothing on an unborn branch', async () => {
    const repo = scratchRepo();

    const listed = await ok('git_branch', {}, repo.path, 'branch-unborn');
    expect(listed.branches).toEqual([]);
  });

  it('git_commit with nothing staged says why (git prints it on stdout)', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');

    const out = await callOperation(
      'git_commit',
      { message: 'empty' },
      inv('commit-nothing'),
      ctx(repo.path),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('tool_failed');
    expect(out.error.message).toMatch(
      /^git_commit failed \(exit 1\): On branch main\nnothing to commit, working tree clean$/,
    );
  });

  it('git_commit keeps stderr as the reason when git wrote one', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');
    repo.git(['config', 'user.useConfigOnly', 'true']);
    repo.git(['config', '--unset', 'user.email']);
    writeFileSync(join(repo.path, 'a.txt'), 'b\n');
    repo.git(['add', '--', 'a.txt']);

    const out = await callOperation(
      'git_commit',
      { message: 'no identity' },
      inv('commit-stderr'),
      ctx(repo.path),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toMatch(/^git_commit failed \(exit 128\): /);
    expect(out.error.message.length).toBeGreaterThan(
      'git_commit failed (exit 128): '.length,
    );
  });

  // Follow-up audit: git_stage / git_branch create / git_checkpoint failures
  // were suspected of an empty reason like git_commit's (stdout-only). Real
  // git writes every one of these to stderr, so each reason is already
  // informative; pinned so a git or wiring change cannot silently blank them.
  async function failure(
    name: OperationName,
    args: unknown,
    dir: string,
    id: string,
  ): Promise<string> {
    const out = await callOperation(name, args, inv(id), ctx(dir));
    if (out.ok) throw new Error(`${name} unexpectedly succeeded`);
    expect(out.error.code).toBe('tool_failed');
    return out.error.message;
  }

  it('git_stage of a nonexistent path names the pathspec git rejected', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');

    expect(
      await failure('git_stage', { paths: ['nope.txt'] }, repo.path, 'stage-x'),
    ).toBe(
      "git_stage failed (exit 128): fatal: pathspec 'nope.txt' did not match any files",
    );
  });

  it('git_branch create of an existing name says the branch exists', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'a\n');

    expect(
      await failure('git_branch', { create: 'main' }, repo.path, 'branch-dup'),
    ).toBe(
      "git_branch failed (exit 128): fatal: a branch named 'main' already exists",
    );
  });

  it("git_checkpoint names a clean tree, and an unborn branch by git's own words", async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo.path, 'a.txt'), 'a\n');
    repo.git(['add', '--', 'a.txt']);
    expect(
      await failure('git_checkpoint', { message: 'm' }, repo.path, 'cp-unborn'),
    ).toBe(
      'git_checkpoint failed (exit 1): You do not have the initial commit yet',
    );

    repo.git(['commit', '-q', '-m', 'first']);
    expect(
      await failure('git_checkpoint', { message: 'm' }, repo.path, 'cp-clean'),
    ).toBe('git_checkpoint: no changes to checkpoint (clean tree)');
  });

  it('returns the patch for a ref', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    writeFileSync(join(repo.path, 'a.txt'), 'one\ntwo\n');
    repo.git(['commit', '-qam', 'v2']);

    const shown = await ok('git_show', { ref: 'HEAD' }, repo.path, 'show');
    expect(shown.patch).toContain('+two');
  });
});

// Structured merge/conflict/worktree tools.
// The operations do not exist yet.
describe('git_merge over real git', () => {
  function conflictingRepo(): GitSandbox {
    const repo = scratchRepo();
    commitFile(repo, 'f.txt', 'base\n');
    repo.git(['checkout', '-qb', 'feature']);
    commitFile(repo, 'f.txt', 'theirs\n');
    repo.git(['checkout', '-q', 'main']);
    commitFile(repo, 'f.txt', 'ours\n');
    return repo;
  }

  it('merges cleanly when there is nothing to conflict', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    repo.git(['checkout', '-qb', 'feature']);
    commitFile(repo, 'b.txt', 'two\n');
    repo.git(['checkout', '-q', 'main']);

    const merged = await ok(
      'git_merge',
      { branch: 'feature' },
      repo.path,
      'mg-clean',
    );
    expect(merged).toEqual({ merged: true, conflicts: [] });
    expect(readFileSync(join(repo.path, 'b.txt'), 'utf8')).toBe('two\n');
  });

  it('returns a structured conflict list and leaves the merge state', async () => {
    const repo = conflictingRepo();
    const out = await callOperation(
      'git_merge',
      { branch: 'feature' },
      inv('mg-conf'),
      ctx(repo.path),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.merged).toBe(false);
      expect(out.result.conflicts).toEqual(['f.txt']);
    }
    // The repo stays in merge state for the resolver: MERGE_HEAD present.
    expect(existsSync(join(repo.path, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it("refuses a missing branch with git's own words", async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    const out = await callOperation(
      'git_merge',
      { branch: 'nope' },
      inv('mg-missing'),
      ctx(repo.path),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.message).toContain('git_merge failed (exit 1)');
    }
  });
});

describe('git_conflict_status over real git', () => {
  it('lists conflicted paths, empty when clean', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'f.txt', 'base\n');
    expect(
      (await ok('git_conflict_status', {}, repo.path, 'cs-clean')).conflicts,
    ).toEqual([]);

    repo.git(['checkout', '-qb', 'feature']);
    commitFile(repo, 'f.txt', 'theirs\n');
    repo.git(['checkout', '-q', 'main']);
    commitFile(repo, 'f.txt', 'ours\n');
    // A conflicting merge exits 1: the non-throwing variant.
    repo.gitResult(['merge', 'feature']);
    expect(
      (await ok('git_conflict_status', {}, repo.path, 'cs-conf')).conflicts,
    ).toEqual(['f.txt']);
  });
});

describe('git_worktree_list over real git', () => {
  it('returns path/branch/head rows for the main checkout', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    const listed = await ok('git_worktree_list', {}, repo.path, 'wl-main');
    expect(listed.worktrees).toHaveLength(1);
    expect(listed.worktrees[0]).toMatchObject({
      path: repo.path,
      branch: 'main',
    });
    expect(listed.worktrees[0]?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a clipped real diff carries a stat summary', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'big.txt', 'one\n');
    writeFileSync(
      join(repo.path, 'big.txt'),
      `${'changed line\n'.repeat(2500)}`,
    );
    const diff = await ok('git_diff', {}, repo.path, 'diff-clip-call');
    expect(diff.truncated).toBe(true);
    expect(diff.stat).toContain('big.txt');
    expect(diff.stat).toContain('changed');
  });

  it('git_status carries the real root and an empty submodule list', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    const status = await ok('git_status', {}, repo.path, 'st-root-call');
    expect(status.repoRoot).toBe(repo.path);
    expect(status.submodules).toEqual([]);
  });

  it('lists an attached worktree alongside the main checkout', async () => {
    const repo = scratchRepo();
    commitFile(repo, 'a.txt', 'one\n');
    // Inside the sandbox's scratch dir, so disposeAllGitSandboxes removes it.
    const wt = join(repo.path, '..', 'linked-wt');
    repo.git(['worktree', 'add', '--detach', wt]);
    const listed = await ok('git_worktree_list', {}, repo.path, 'wl-linked');
    expect(listed.worktrees.map((row) => row.path).sort()).toEqual(
      [repo.path, wt].sort(),
    );
    const linked = listed.worktrees.find((row) => row.path === wt);
    expect(linked?.detached).toBe(true);
  });
});
