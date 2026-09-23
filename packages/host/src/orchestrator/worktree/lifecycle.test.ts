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
  it('removes the worktree but keeps the branch', async () => {
    const env = new FakeExecutionEnv({
      'git worktree remove /repo/.kubic/wt/agent-1': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
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
    });
    const result = await removeWorktree(env, '/repo/.kubic/wt/agent-2', {
      force: true,
    });
    expect(result.removed).toBe(true);
  });
});
