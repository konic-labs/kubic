// Slice B: git log/show read ops (issue #19; §43.1).
// RED: git_log/git_show do not exist yet.
import { describe, expect, it } from 'vitest';
import { argvKey, FakeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(
  scripts: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): OpContext {
  return {
    env: new FakeExecutionEnv(scripts),
    sessionId: 's1',
    agentId: 'root',
  };
}

// Human form of the recorded argv, for exact-argv pins (issue #356).
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
}

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

const LOG_OUT = `abc1234\u001fauthor one\u001f2026-09-01\u001ffirst commit
def5678\u001fauthor two\u001f2026-09-02\u001fsecond commit
`;

describe('git log/show (issue #19, slice B)', () => {
  it('git_log parses entries with sha/author/date/message', async () => {
    const env = new FakeExecutionEnv({
      [argvKey(
        'git',
        'log',
        '--format=%H%x1f%an%x1f%ad%x1f%s',
        '--date=short',
        '-n',
        '10',
      )]: {
        exitCode: 0,
        stdout: LOG_OUT,
        stderr: '',
      },
    });
    const out = await callOperation('git_log', { max: 10 }, inv('a'), {
      env,
      sessionId: 's1',
      agentId: 'root',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.entries).toEqual([
        {
          sha: 'abc1234',
          author: 'author one',
          date: '2026-09-01',
          message: 'first commit',
        },
        {
          sha: 'def5678',
          author: 'author two',
          date: '2026-09-02',
          message: 'second commit',
        },
      ]);
    }
    expect(argvOf(env)).toEqual([
      'git log --format=%H%x1f%an%x1f%ad%x1f%s --date=short -n 10',
    ]);
  });

  it('git_show returns the patch for a ref', async () => {
    const out = await callOperation(
      'git_show',
      { ref: 'abc1234' },
      inv('b'),
      ctx({
        [argvKey('git', 'show', '--format=', '--patch', 'abc1234')]: {
          exitCode: 0,
          stdout: 'diff --git a/x b/x\n',
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.patch).toBe('diff --git a/x b/x\n');
  });

  it('git_log is unavailable-with-reason outside a repo', async () => {
    const out = await callOperation(
      'git_log',
      {},
      inv('c'),
      ctx({
        [argvKey(
          'git',
          'log',
          '--format=%H%x1f%an%x1f%ad%x1f%s',
          '--date=short',
          '-n',
          '20',
        )]: {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not_a_repo');
  });
});
