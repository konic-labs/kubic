// Slice A: structured git status/diff ops (issue #19; §43.1; issue #193
// switched the status parser to porcelain v2 -z).
// RED: git ops do not exist yet.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { argvKey, FakeExecutionEnv } from '../../../exec/src/env.js';
import { createSessionSpillSink } from '../spill.js';
import { BASH_RESULT_MAX_CHARS } from './bash.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(
  scripts: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): OpContext {
  const env = new FakeExecutionEnv(scripts);
  return { env, sessionId: 's1', agentId: 'root' };
}

// Human form of the recorded argv, for exact-argv pins (issue #356).
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-g1', operationId: 'op-g1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
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
        [argvKey('git', 'status', '--porcelain=v2', '-z', '-b')]: {
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
        [argvKey('git', 'status', '--porcelain=v2', '-z', '-b')]: {
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
        [argvKey('git', 'status', '--porcelain=v2', '-z', '-b')]: {
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
      [argvKey('git', 'diff', '--staged', '--', 'a.txt')]: {
        exitCode: 0,
        stdout: 'diff --git a/a.txt b/a.txt\n',
        stderr: '',
      },
    };
    const env = new FakeExecutionEnv(scripts);
    const c: OpContext = { env, sessionId: 's1', agentId: 'root' };
    const out = await callOperation(
      'git_diff',
      { staged: true, path: 'a.txt' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.diff).toBe('diff --git a/a.txt b/a.txt\n');
    expect(argvOf(env)).toEqual(['git diff --staged -- a.txt']);
    // Range scoping: the revision range is its own argv element before
    // the `--` path separator. The strict fake answers only the exact
    // argv, so a range merged into the path (or vice versa) throws
    // instead of returning this diff.
    const ranged = await callOperation(
      'git_diff',
      { range: 'main..HEAD', path: 'a.txt' },
      inv(),
      ctx({
        [argvKey('git', 'diff', 'main..HEAD', '--', 'a.txt')]: {
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
      [argvKey('git', 'status', '--porcelain=v2', '-z', '-b')]: {
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

describe('git output bounds (issue #190)', () => {
  // RED first: written before git_diff/git_show/git_log clipped anything —
  // each result carried the full megabyte with no truncated flag.
  it('git_diff over a 1 MB change returns <= cap with truncated true', async () => {
    const big = `diff --git a/big.bin b/big.bin\n${'x'.repeat(1024 * 1024)}\n`;
    const out = await callOperation(
      'git_diff',
      {},
      inv(),
      ctx({ 'git diff': { exitCode: 0, stdout: big, stderr: '' } }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.diff.length).toBeLessThanOrEqual(
      BASH_RESULT_MAX_CHARS + 512,
    );
    // Tail kept: the end of the change survives, the head does not.
    expect(out.result.diff.endsWith(`${'x'.repeat(64)}\n`)).toBe(true);
    expect(out.result.diff).not.toContain('diff --git');
  });

  it('git_show clips a huge patch and spills the full text when sunk', async () => {
    const big = `commit abc\n${'y'.repeat(200 * 1024)}\n`;
    const session = tmp('git-190-session-');
    const sunk = {
      ...ctx({
        'git show --format= --patch HEAD': {
          exitCode: 0,
          stdout: big,
          stderr: '',
        },
      }),
      spill: createSessionSpillSink(session),
    };
    const out = await callOperation('git_show', { ref: 'HEAD' }, inv(), sunk);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.spillPath).toBeDefined();
    expect(readFileSync(out.result.spillPath as string, 'utf8')).toBe(big);
    // No sink: same clip, no path, shape unchanged otherwise.
    const bare = await callOperation(
      'git_show',
      { ref: 'HEAD' },
      inv(),
      ctx({
        'git show --format= --patch HEAD': {
          exitCode: 0,
          stdout: big,
          stderr: '',
        },
      }),
    );
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.result.truncated).toBe(true);
    expect(bare.result.spillPath).toBeUndefined();
  });

  it('git_log clips an unbounded history with truncated true', async () => {
    const raw = Array.from(
      { length: 5000 },
      (_, n) =>
        `sha${n}\u001fauthor\u001f2026-01-01\u001fmsg ${n} ${'z'.repeat(300)}`,
    ).join('\n');
    expect(raw.length).toBeGreaterThan(BASH_RESULT_MAX_CHARS);
    const out = await callOperation(
      'git_log',
      {},
      inv(),
      ctx({
        'git log --format=%H%x1f%an%x1f%ad%x1f%s --date=short -n 20': {
          exitCode: 0,
          stdout: raw,
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.entries.length).toBeGreaterThan(0);
    expect(out.result.entries.length).toBeLessThan(5000);
  });
});
