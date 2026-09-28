// Worktree settle + retain + remove (issue #45, slice 3).
// RED first: settle keeps the branch, post-merge retains wt+branch
// (§44.1), and remove never deletes the branch.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import { removeWorktree } from './remove.js';
import { getWorktreeStatus, markMerged, settleWorktree } from './status.js';

describe('settle and retain (issue #45)', () => {
  it('settle keeps the branch on the worktree', () => {
    const settled = settleWorktree({
      path: '/repo/.kubic/wt/agent-1',
      branch: 'kubic/agent-1',
      bare: false,
      detached: false,
    });
    expect(settled.settled).toBe(true);
    expect(settled.branchKept).toBe(true);
    expect(settled.branch).toBe('kubic/agent-1');
  });

  it('post-merge retains wt+branch; only clean removes', () => {
    const merged = markMerged({
      path: '/repo/.kubic/wt/agent-1',
      branch: 'kubic/agent-1',
      bare: false,
      detached: false,
    });
    expect(merged.merged).toBe(true);
    expect(merged.retained).toBe(true);
    expect(merged.removed).toBe(false);
  });

  it('reads live status through the shell seam', async () => {
    const env = new FakeExecutionEnv({
      'git -C /repo/.kubic/wt/agent-1 status --porcelain=v1 -b': {
        exitCode: 0,
        stdout: '## kubic/agent-1\n M edited.txt\n?? new.txt\n',
        stderr: '',
      },
    });
    const status = await getWorktreeStatus(env, '/repo/.kubic/wt/agent-1');
    expect(status.branch).toBe('kubic/agent-1');
    expect(status.clean).toBe(false);
    expect(status.unstaged).toEqual(['edited.txt']);
    expect(status.untracked).toEqual(['new.txt']);
  });
});

describe('removeWorktree (issue #45)', () => {
  // The fake shell answers any UNSCRIPTED argv with exit 0, so the argv the
  // test must not see is scripted to FAIL: a stray `--force` or a branch
  // delete then surfaces as a thrown remove instead of passing silently.
  const REFUSED = { exitCode: 1, stdout: '', stderr: 'unexpected argv' };

  it('removes the worktree but keeps the branch', async () => {
    const env = new FakeExecutionEnv({
      'git worktree remove /repo/.kubic/wt/agent-1': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'git worktree remove /repo/.kubic/wt/agent-1 --force': REFUSED,
      'git branch -D kubic/agent-1': REFUSED,
    });
    const result = await removeWorktree(env, '/repo/.kubic/wt/agent-1');
    expect(result.removed).toBe(true);
    expect(result.branchKept).toBe(true);
    expect(result.branch).toBe('kubic/agent-1');
  });

  it('passes --force only when asked', async () => {
    const env = new FakeExecutionEnv({
      'git worktree remove /repo/.kubic/wt/agent-2 --force': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'git worktree remove /repo/.kubic/wt/agent-2': REFUSED,
    });
    const result = await removeWorktree(env, '/repo/.kubic/wt/agent-2', {
      force: true,
    });
    expect(result.removed).toBe(true);
  });

  it('refuses a foreign absolute path outside the spawned set', async () => {
    const env = new FakeExecutionEnv({});
    const shaped = await removeWorktree(env, '/other/.kubic/wt/agent-9', {
      repoRoot: '/repo',
    }).catch((e: unknown) => e);
    expect((shaped as { code?: string }).code).toBe('remove_failed');
    expect((shaped as Error).message).toMatch(/outside the spawned set/);
    const foreign = await removeWorktree(env, '/etc/cron.d/x', {
      repoRoot: '/repo',
    }).catch((e: unknown) => e);
    expect((foreign as { code?: string }).code).toBe('remove_failed');
    const unanchored = await removeWorktree(env, '/etc/cron.d/x').catch(
      (e: unknown) => e,
    );
    expect((unanchored as { code?: string }).code).toBe('remove_failed');
  });

  it('refuses status for a foreign absolute path', async () => {
    const env = new FakeExecutionEnv({});
    const error = await getWorktreeStatus(env, '/repo/other.txt', {
      repoRoot: '/repo',
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('status_failed');
  });
});
