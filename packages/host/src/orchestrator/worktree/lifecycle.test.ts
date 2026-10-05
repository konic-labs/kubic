// Worktree settle + retain + remove (issue #45, slice 3).
// RED first: settle keeps the branch, post-merge retains wt+branch
// (§44.1), and remove never deletes the branch.
import { describe, expect, it } from 'vitest';
import {
  FakeExecutionEnv,
  type FakeSpawnCall,
} from '../../../../exec/src/env.js';
import { removeWorktree } from './remove.js';
import { getWorktreeStatus, markMerged, settleWorktree } from './status.js';

// Exact argv issued, in order — the strict fake throws on anything
// unscripted, and this pins what was scripted (issue #212).
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map(
    (call: FakeSpawnCall) => `${call.cmd} ${call.args.join(' ')}`,
  );
}

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

  it('reads live status through the shell seam (porcelain v2, issue #388)', async () => {
    const env = new FakeExecutionEnv(
      {
        'git -C /repo/.kubic/wt/agent-1 status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout:
            '# branch.oid abc1234\0# branch.head kubic/agent-1\0' +
            '1 .M N... 100644 100644 100644 1111111 2222222 edited.txt\0' +
            '? new.txt\0',
          stderr: '',
        },
      },
      { strict: true },
    );
    const status = await getWorktreeStatus(env, '/repo/.kubic/wt/agent-1');
    expect(status.branch).toBe('kubic/agent-1');
    expect(status.clean).toBe(false);
    expect(status.unstaged).toEqual(['edited.txt']);
    expect(status.untracked).toEqual(['new.txt']);
    expect(argvOf(env)).toEqual([
      'git -C /repo/.kubic/wt/agent-1 status --porcelain=v2 -z -b',
    ]);
  });

  it('reports renames by new path and detached HEAD as null (issue #388)', async () => {
    const env = new FakeExecutionEnv({
      'git -C /repo/.kubic/wt/agent-1 status --porcelain=v2 -z -b': {
        exitCode: 0,
        stdout:
          '# branch.oid abc1234\0# branch.head (detached)\0' +
          '2 R. N... 100644 100644 100644 1111111 2222222 R100 new.txt\0old.txt\0',
        stderr: '',
      },
    });
    const status = await getWorktreeStatus(env, '/repo/.kubic/wt/agent-1');
    expect(status.branch).toBeNull();
    expect(status.staged).toEqual(['new.txt']);
    expect(status.renames).toEqual([
      { path: 'new.txt', oldPath: 'old.txt', staged: true },
    ]);
  });
});

describe('removeWorktree (issue #45)', () => {
  // Strict fake: any argv the test did not script — a stray `--force` or
  // a branch delete — throws instead of exiting 0 (issue #212). The old
  // REFUSED workaround (scripting the forbidden argv to fail) is gone.
  it('removes the worktree but keeps the branch', async () => {
    const env = new FakeExecutionEnv(
      {
        'git worktree remove /repo/.kubic/wt/agent-1': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      },
      { strict: true },
    );
    const result = await removeWorktree(env, '/repo/.kubic/wt/agent-1');
    expect(result.removed).toBe(true);
    expect(result.branchKept).toBe(true);
    expect(result.branch).toBe('kubic/agent-1');
    // No branch delete, no --force: exactly one argv issued.
    expect(argvOf(env)).toEqual([
      'git worktree remove /repo/.kubic/wt/agent-1',
    ]);
  });

  it('passes --force only when asked', async () => {
    const env = new FakeExecutionEnv(
      {
        'git worktree remove /repo/.kubic/wt/agent-2 --force': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      },
      { strict: true },
    );
    const result = await removeWorktree(env, '/repo/.kubic/wt/agent-2', {
      force: true,
    });
    expect(result.removed).toBe(true);
    expect(argvOf(env)).toEqual([
      'git worktree remove /repo/.kubic/wt/agent-2 --force',
    ]);
  });

  it('refuses a foreign absolute path outside the spawned set', async () => {
    const env = new FakeExecutionEnv({}, { strict: true });
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
    // Refusal happens before any spawn: git never runs.
    expect(argvOf(env)).toEqual([]);
  });

  it('refuses status for a foreign absolute path', async () => {
    const env = new FakeExecutionEnv({}, { strict: true });
    const error = await getWorktreeStatus(env, '/repo/other.txt', {
      repoRoot: '/repo',
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('status_failed');
    expect(argvOf(env)).toEqual([]);
  });
});
