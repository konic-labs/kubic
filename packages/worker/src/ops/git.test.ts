// Slice A: structured git status/diff ops (issue #19; §43.1; issue #193
// switched the status parser to porcelain v2 -z).
// RED: git ops do not exist yet.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(
  scripts: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): OpContext {
  const env = new FakeExecutionEnv(scripts);
  return { env, sessionId: 's1', agentId: 'root' };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-g1', operationId: 'op-g1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

const STATUS_OUT = [
  '# branch.oid abc1234\0',
  '# branch.head main\0',
  '# branch.upstream origin/main\0',
  '# branch.ab +1 -0\0',
  '1 M. N... 100644 100644 100644 1111111 2222222 staged.txt\0',
  '1 .M N... 100644 100644 100644 1111111 2222222 unstaged.txt\0',
  '1 MM N... 100644 100644 100644 1111111 2222222 both.txt\0',
  '2 R. N... 100644 100644 100644 1111111 2222222 R100 renamed.txt\0original.txt\0',
  'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt\0',
  '? new.txt\0',
].join('');

describe('git ops (issue #19, slice A)', () => {
  it('git_status returns structured state', async () => {
    const out = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout: STATUS_OUT,
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.branch).toBe('main');
      expect(out.result.ahead).toBe(1);
      expect(out.result.behind).toBe(0);
      expect(out.result.staged).toEqual([
        'staged.txt',
        'both.txt',
        'renamed.txt',
        'conflict.txt',
      ]);
      expect(out.result.unstaged).toEqual([
        'unstaged.txt',
        'both.txt',
        'conflict.txt',
      ]);
      expect(out.result.untracked).toEqual(['new.txt']);
      expect(out.result.renames).toEqual([
        { path: 'renamed.txt', oldPath: 'original.txt', staged: true },
      ]);
      expect(out.result.clean).toBe(false);
    }
  });

  it('git_status reports a detached HEAD as null and an unborn branch by name', async () => {
    const detached = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout: '# branch.oid abc1234\0# branch.head (detached)\0',
          stderr: '',
        },
      }),
    );
    expect(detached.ok).toBe(true);
    if (detached.ok) expect(detached.result.branch).toBeNull();
    const unborn = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout: '# branch.oid (initial)\0# branch.head main\0',
          stderr: '',
        },
      }),
    );
    expect(unborn.ok).toBe(true);
    if (unborn.ok) expect(unborn.result.branch).toBe('main');
  });

  it('git_diff scopes staged, range, and path', async () => {
    const scripts = {
      'git diff --staged -- a.txt': {
        exitCode: 0,
        stdout: 'diff --git a/a.txt b/a.txt\n',
        stderr: '',
      },
    };
    const out = await callOperation(
      'git_diff',
      { staged: true, path: 'a.txt' },
      inv(),
      ctx(scripts),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.diff).toBe('diff --git a/a.txt b/a.txt\n');
    // Range scoping: the revision range is its own argv element before
    // the `--` path separator. (An unscripted fake spawn yields '', so a
    // wrong argv cannot produce this diff.)
    const ranged = await callOperation(
      'git_diff',
      { range: 'main..HEAD', path: 'a.txt' },
      inv(),
      ctx({
        'git diff main..HEAD -- a.txt': {
          exitCode: 0,
          stdout: 'diff --git a/a.txt b/a.txt\n+ranged\n',
          stderr: '',
        },
      }),
    );
    expect(ranged.ok).toBe(true);
    if (ranged.ok) {
      expect(ranged.result.diff).toBe('diff --git a/a.txt b/a.txt\n+ranged\n');
    }
  });

  it('reports unavailable-with-reason outside a repo, and never inits', async () => {
    const scripts = {
      'git status --porcelain=v2 -z -b': {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    };
    const out = await callOperation('git_status', {}, inv(), ctx(scripts));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('not_a_repo');
      expect(out.error.message).toContain('not a git repository');
    }
  });
});
