// Slice C: git stage/commit/branch/checkpoint effect ops (issue #19; §43.1).
// RED: git_stage/git_commit/git_branch/git_checkpoint do not exist yet.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
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

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('git effects (issue #19, slice C)', () => {
  it('git_stage stages explicit paths only (never -A)', async () => {
    const out = await callOperation(
      'git_stage',
      { paths: ['a.txt'] },
      inv('c1'),
      ctx({ 'git add -- a.txt': { exitCode: 0, stdout: '', stderr: '' } }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.staged).toEqual(['a.txt']);
  });

  it('git_stage refuses empty paths and absolute escapes', async () => {
    for (const args of [
      { paths: [] },
      { paths: ['/etc/passwd'] },
      { paths: ['../up.txt'] },
      { paths: ['a/../../up.txt'] },
    ]) {
      const out = await callOperation(
        'git_stage',
        args,
        inv(
          `c2-${String(args.paths[0] ?? 'empty').replace(/[^A-Za-z0-9]/g, '_')}`,
        ),
        ctx({}),
      );
      // Unscripted fake spawns exit 0, so only validation can refuse.
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('invalid_args');
    }
  });

  it('git_stage refuses dot-dot segments even when they resolve inside', async () => {
    const out = await callOperation(
      'git_stage',
      { paths: ['sub/../ok.txt'] },
      inv('c2b'),
      ctx({}),
    );
    // Rejected: any `..` segment is refused, even one that resolves inside.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });

  it('git_branch refuses hostile names and git_diff refuses dash ranges', async () => {
    for (const create of ['--help', 'a..b', 'has space', '../x', 'a@{1}']) {
      const out = await callOperation(
        'git_branch',
        { create },
        inv(`c7-${create.length}`),
        ctx({}),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('invalid_args');
    }
    const diffed = await callOperation(
      'git_diff',
      { range: '--output=/tmp/x' },
      inv('c8'),
      ctx({}),
    );
    expect(diffed.ok).toBe(false);
    if (!diffed.ok) expect(diffed.error.code).toBe('invalid_args');
  });

  it('git_commit returns the sha plus file list for the trajectory', async () => {
    const scripts = {
      'git commit -m work in progress': {
        exitCode: 0,
        stdout: '[main abc1234] work in progress',
        stderr: '',
      },
      'git rev-parse HEAD': {
        exitCode: 0,
        stdout: 'abc1234567890\n',
        stderr: '',
      },
      'git show -z --name-only --format= abc1234567890': {
        exitCode: 0,
        stdout: 'a.txt\0b.txt\0',
        stderr: '',
      },
    };
    const out = await callOperation(
      'git_commit',
      { message: 'work in progress' },
      inv('c3'),
      ctx(scripts),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.sha).toBe('abc1234567890');
      expect(out.result.files).toEqual(['a.txt', 'b.txt']);
    }
  });

  it('git_checkpoint creates a restorable stash point without touching the tree', async () => {
    const out = await callOperation(
      'git_checkpoint',
      { message: 'before risky edit' },
      inv('c4'),
      ctx({
        'git stash create before risky edit': {
          exitCode: 0,
          stdout: 'deadbeef\n',
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.sha).toBe('deadbeef');
  });

  it('git_branch lists branches and creates new ones', async () => {
    const listed = await callOperation(
      'git_branch',
      {},
      inv('c5'),
      ctx({
        'git branch --format=%(refname:short)': {
          exitCode: 0,
          stdout: 'main\nfeature/x\n',
          stderr: '',
        },
      }),
    );
    expect(listed.ok).toBe(true);
    if (listed.ok)
      expect(listed.result.branches).toEqual(['main', 'feature/x']);
    const created = await callOperation(
      'git_branch',
      { create: 'feature/y' },
      inv('c6'),
      ctx({ 'git branch feature/y': { exitCode: 0, stdout: '', stderr: '' } }),
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.result.created).toBe('feature/y');
  });
});
