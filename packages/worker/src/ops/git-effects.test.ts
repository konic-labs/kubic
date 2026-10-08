// Git stage/commit/branch/checkpoint effect ops.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { argvKey } from '../../../exec/src/test-support/env-fakes.js';
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

// Human form of the recorded argv, for exact-argv pins.
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
}

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('git effects', () => {
  it('git_stage stages explicit paths only (never -A)', async () => {
    const env = new FakeExecutionEnv({
      [argvKey('git', 'add', '--', 'a.txt')]: {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    });
    const out = await callOperation(
      'git_stage',
      { paths: ['a.txt'] },
      inv('c1'),
      { env, sessionId: 's1', agentId: 'root' },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.staged).toEqual(['a.txt']);
    // Exact argv pin: a `git add -A` mutant derives a
    // different key, hits no script, and strict mode throws — so this
    // assertion failing is the mutant being killed.
    expect(argvOf(env)).toEqual(['git add -- a.txt']);
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
      // Rejected by validation before any spawn (the strict fake would
      // throw on an unscripted argv, so reaching the shell fails loudly).
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
      [argvKey('git', 'commit', '-m', 'work in progress')]: {
        exitCode: 0,
        stdout: '[main abc1234] work in progress',
        stderr: '',
      },
      [argvKey('git', 'rev-parse', 'HEAD')]: {
        exitCode: 0,
        stdout: 'abc1234567890\n',
        stderr: '',
      },
      [argvKey(
        'git',
        'show',
        '-z',
        '--name-only',
        '--format=',
        'abc1234567890',
      )]: {
        exitCode: 0,
        stdout: 'a.txt\0b.txt\0',
        stderr: '',
      },
    };
    const env = new FakeExecutionEnv(scripts);
    const out = await callOperation(
      'git_commit',
      { message: 'work in progress' },
      inv('c3'),
      { env, sessionId: 's1', agentId: 'root' },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.sha).toBe('abc1234567890');
      expect(out.result.files).toEqual(['a.txt', 'b.txt']);
    }
    // Single message element, not split: a joined key would conflate
    // `['-m', 'work in progress']` with five elements; the argv-array key
    // does not, and the recorded call proves which the op issued.
    expect(argvOf(env)[0]).toBe('git commit -m work in progress');
    expect(env.calls[0]?.args).toEqual(['commit', '-m', 'work in progress']);
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
  ])('git_commit failure $name', async ({ run, message }) => {
    const out = await callOperation(
      'git_commit',
      { message: 'm' },
      inv('c3f'),
      ctx({ [argvKey('git', 'commit', '-m', 'm')]: run }),
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
        [argvKey('git', 'stash', 'create', 'before risky edit')]: {
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
        [argvKey(
          'git',
          'for-each-ref',
          '--format=%(refname:lstrip=2)',
          'refs/heads',
        )]: {
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
      ctx({
        [argvKey('git', 'branch', 'feature/y')]: {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      }),
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.result.created).toBe('feature/y');
  });
});

describe('git kill registry', () => {
  // The op hands its kill to the lane registry under the invocation's
  // operation id and unregisters on settle. runGit must call trackHandle, or the
  // registry stays empty mid-flight.
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
