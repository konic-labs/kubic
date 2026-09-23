// Slice A: structured git status/diff ops (issue #19; §43.1).
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

const STATUS_OUT = `## main...origin/main [ahead 1]
M  staged.txt
 M unstaged.txt
?? new.txt
`;

describe('git ops (issue #19, slice A)', () => {
  it('git_status returns structured state', async () => {
    const out = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v1 -b': {
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
      expect(out.result.staged).toEqual(['staged.txt']);
      expect(out.result.unstaged).toEqual(['unstaged.txt']);
      expect(out.result.untracked).toEqual(['new.txt']);
      expect(out.result.clean).toBe(false);
    }
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
    if (out.ok) expect(out.result.diff).toContain('diff --git');
  });

  it('reports unavailable-with-reason outside a repo, and never inits', async () => {
    const scripts = {
      'git status --porcelain=v1 -b': {
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
