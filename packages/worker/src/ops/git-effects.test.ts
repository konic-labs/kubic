// Slice C: git stage/commit/branch/checkpoint effect ops (issue #19; §43.1).
// RED: git_stage/git_commit/git_branch/git_checkpoint do not exist yet.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { OperationKillRegistry } from '../lane/abort.js';
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

  it.each([
    {
      name: 'falls back to trimmed stdout when git wrote nothing to stderr',
      run: { exitCode: 1, stdout: '  nothing to commit\n', stderr: ' \n' },
      message: 'git_commit failed (exit 1): nothing to commit',
    },
    {
      name: 'prefers stderr over stdout when both are present',
      run: { exitCode: 128, stdout: 'ignored', stderr: '\nfatal: boom\n' },
      message: 'git_commit failed (exit 128): fatal: boom',
    },
    {
      name: 'bounds the reason at 200 characters',
      run: { exitCode: 1, stdout: 'x'.repeat(300), stderr: '' },
      message: `git_commit failed (exit 1): ${'x'.repeat(200)}`,
    },
  ])('git_commit failure $name (issue #193)', async ({ run, message }) => {
    const out = await callOperation(
      'git_commit',
      { message: 'm' },
      inv('c3f'),
      ctx({ 'git commit -m m': run }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('tool_failed');
    expect(out.error.message).toBe(message);
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
        'git for-each-ref --format=%(refname:lstrip=2) refs/heads': {
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

describe('git kill registry (issue #190)', () => {
  // The op hands its kill to the lane registry under the invocation's
  // operation id and unregisters on settle — before this change runGit
  // never called trackHandle, so the registry stayed empty mid-flight.
  it('git_commit registers its kill under the operation id, then untracks', async () => {
    const registry = new OperationKillRegistry();
    const seen: string[] = [];
    const scripts = {
      'git commit -m wip': {
        exitCode: 0,
        stdout: '[main abc] wip',
        stderr: '',
      },
      'git rev-parse HEAD': { exitCode: 0, stdout: 'abc\n', stderr: '' },
      'git show -z --name-only --format= abc': {
        exitCode: 0,
        stdout: 'a.txt\0',
        stderr: '',
      },
    };
    const env = new FakeExecutionEnv(scripts);
    const trackedCtx: OpContext = {
      env,
      sessionId: 's1',
      agentId: 'root',
      trackHandle: (kill, invocation) => {
        seen.push(String(invocation.operationId));
        return registry.track(String(invocation.operationId), kill);
      },
    };
    const out = await callOperation(
      'git_commit',
      { message: 'wip' },
      inv('git-commit-track-1'),
      trackedCtx,
    );
    expect(out.ok).toBe(true);
    // All three child spawns (commit, rev-parse, show) registered.
    expect(seen).toEqual([
      'git-commit-track-1',
      'git-commit-track-1',
      'git-commit-track-1',
    ]);
    // ...and every one unregistered on settle: no leak in the registry.
    expect(registry.drain('git-commit-track-1')).toEqual([]);
  });
});
