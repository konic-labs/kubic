// Worktree list: `git worktree list` shows every spawn (issue #45, slice 3).
// RED first: porcelain parse + 3 parallel spawns visible as 3 entries.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import { listWorktrees, parseWorktreePorcelain } from './list.js';

export const THREE_WT_PORCELAIN = `worktree /repo
HEAD abcdef0123456789
branch refs/heads/main

worktree /repo/.kubic/wt/agent-1
HEAD 1111111111111111
branch refs/heads/kubic/agent-1

worktree /repo/.kubic/wt/agent-2
HEAD 2222222222222222
branch refs/heads/kubic/agent-2

worktree /repo/.kubic/wt/agent-3
HEAD 3333333333333333
branch refs/heads/kubic/agent-3
`;

describe('listWorktrees (issue #45)', () => {
  it('parses porcelain blocks into entries', () => {
    const entries = parseWorktreePorcelain(THREE_WT_PORCELAIN);
    expect(entries).toHaveLength(4);
    expect(entries[1]).toMatchObject({
      path: '/repo/.kubic/wt/agent-1',
      branch: 'kubic/agent-1',
    });
  });

  it('shows 3 parallel spawns as 3 kubic/* worktrees (§85 mirror)', async () => {
    const env = new FakeExecutionEnv({
      'git worktree list --porcelain': {
        exitCode: 0,
        stdout: THREE_WT_PORCELAIN,
        stderr: '',
      },
    });
    const entries = await listWorktrees(env);
    const spawned = entries.filter((e) =>
      e.path.startsWith('/repo/.kubic/wt/'),
    );
    expect(spawned).toHaveLength(3);
    expect(spawned.map((e) => e.branch).sort()).toEqual([
      'kubic/agent-1',
      'kubic/agent-2',
      'kubic/agent-3',
    ]);
  });

  it('refuses list outside a repo with exit 5', async () => {
    const env = new FakeExecutionEnv({
      'git worktree list --porcelain': {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    });
    const error = await listWorktrees(env).catch((e: unknown) => e);
    expect((error as { exitCode?: number }).exitCode).toBe(5);
  });
});
