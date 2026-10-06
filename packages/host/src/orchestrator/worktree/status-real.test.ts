// getWorktreeStatus over real git (issue #388): the v2 reader reports a
// rename by its new path (never `old -> new`), returns quoted/non-ASCII
// paths unquoted, and reports a detached HEAD as null — the same values
// `git_status` produces, through the shared parser.
//
// Hermetic (issue #365): the repo is a nested scratch repo inside a shared
// git sandbox — system git config is off and the ambient GIT_DIR family is
// scrubbed — so the status child sees exactly the repo-local config.
// The sandbox owns every scratch dir (removed in afterEach); no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  NodeExecutionEnv,
} from '../../../../exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../../exec/src/test-support/git-sandbox.js';
import { getWorktreeStatus } from './status.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

/**
 * A scratch repo nested at the spawned-worktree shape
 * `<sandbox>/.kubic/wt/agent-1`, on a branch with one committed file.
 * The outer sandbox supplies the hermetic env; the inner repo is what the
 * status reader sees.
 */
function worktreeRepo(): {
  dir: string;
  env: ExecutionEnv;
  sandbox: GitSandbox;
} {
  const sandbox = createGitSandbox({
    prefix: 'kubic-wt-status-',
    injectProcessEnv: true,
  });
  const dir = join(sandbox.path, '.kubic', 'wt', 'agent-1');
  mkdirSync(dir, { recursive: true });
  sandbox.git(['init', '-q', dir]);
  sandbox.git(['-C', dir, 'config', 'user.email', 'test@kubic.dev']);
  sandbox.git(['-C', dir, 'config', 'user.name', 'kubic-test']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  sandbox.git(['-C', dir, 'add', '--', 'base.txt']);
  sandbox.git(['-C', dir, 'commit', '-q', '-m', 'base']);
  sandbox.git(['-C', dir, 'checkout', '-q', '-b', 'topic']);
  return { dir, env: new NodeExecutionEnv(dir), sandbox };
}

describe('getWorktreeStatus over real git (issue #388)', () => {
  it('reports a rename by its new path, never `old -> new`', async () => {
    const { dir, env, sandbox } = worktreeRepo();
    writeFileSync(join(dir, 'old.txt'), 'move me\n');
    sandbox.git(['-C', dir, 'add', '--', 'old.txt']);
    sandbox.git(['-C', dir, 'commit', '-q', '-m', 'old']);
    sandbox.git(['-C', dir, 'mv', 'old.txt', 'new.txt']);
    const status = await getWorktreeStatus(env, dir);
    expect(status.branch).toBe('topic');
    expect(status.staged).toEqual(['new.txt']);
    expect(status.renames).toEqual([
      { path: 'new.txt', oldPath: 'old.txt', staged: true },
    ]);
    expect(JSON.stringify(status)).not.toContain('old -> new');
  });

  it('returns quoted and non-ASCII paths unquoted', async () => {
    const { dir, env } = worktreeRepo();
    const name = 'naïve "quoted" name.txt';
    writeFileSync(join(dir, name), 'x\n');
    const status = await getWorktreeStatus(env, dir);
    expect(status.untracked).toEqual([name]);
  });

  it('reports a detached HEAD as null', async () => {
    const { dir, env, sandbox } = worktreeRepo();
    sandbox.git(['-C', dir, 'checkout', '-q', '--detach', 'HEAD']);
    const status = await getWorktreeStatus(env, dir);
    expect(status.branch).toBeNull();
    expect(status.clean).toBe(true);
  });
});
