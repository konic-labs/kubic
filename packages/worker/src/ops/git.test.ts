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
import { runGit } from './git.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(
  scripts: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): OpContext {
  // Fakes are strict-by-default: every git_status issues its root and
  // submodule queries, so the defaults script them (explicit entries win).
  const env = new FakeExecutionEnv({
    'git rev-parse --show-toplevel': {
      exitCode: 0,
      stdout: '/repo\n',
      stderr: '',
    },
    'git submodule status': { exitCode: 0, stdout: '', stderr: '' },
    ...scripts,
  });
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

describe('git conflict routing (issue #380)', () => {
  // RED first: unmerged XY codes land in staged+unstaged with no
  // conflicts field at all.
  it.each([['UU'], ['AA'], ['DD'], ['AU'], ['UA'], ['DU'], ['UD']])(
    'routes %s to conflicts only',
    async (code) => {
      const out = await callOperation(
        'git_status',
        {},
        inv(),
        ctx({
          'git status --porcelain=v2 -z -b': {
            exitCode: 0,
            stdout: [
              '# branch.oid abc1234\0',
              '# branch.head main\0',
              `# branch.ab +0 -0\0`,
              `u ${code} N... 100644 100644 100644 100644 1111111 2222222 3333333 cl.txt\0`,
            ].join(''),
            stderr: '',
          },
        }),
      );
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result.conflicts).toEqual(['cl.txt']);
        expect(out.result.staged).toEqual([]);
        expect(out.result.unstaged).toEqual([]);
        expect(out.result.clean).toBe(false);
      }
    },
  );
});

describe('git status root and submodules (issue #380)', () => {
  it('carries the repo root and submodule summary', async () => {
    const out = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout: '# branch.oid abc1234\0# branch.head main\0',
          stderr: '',
        },
        'git rev-parse --show-toplevel': {
          exitCode: 0,
          stdout: '/repo\n',
          stderr: '',
        },
        'git submodule status': {
          exitCode: 0,
          stdout:
            ' 1111111111111111111111111111111111111111 libs/clean (v1.0)\n+2222222222222222222222222222222222222222 libs/dirty\n-3333333333333333333333333333333333333333 libs/empty\nU4444444444444444444444444444444444444444 libs/conflicted\n',
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.repoRoot).toBe('/repo');
      expect(out.result.submodules).toEqual([
        { path: 'libs/clean', state: 'clean' },
        { path: 'libs/dirty', state: 'modified' },
        { path: 'libs/empty', state: 'uninitialized' },
        { path: 'libs/conflicted', state: 'conflict' },
      ]);
    }
  });

  it('stands without the root and submodules on an exotic repo', async () => {
    const out = await callOperation(
      'git_status',
      {},
      inv(),
      ctx({
        'git status --porcelain=v2 -z -b': {
          exitCode: 0,
          stdout: '# branch.oid abc1234\0# branch.head main\0',
          stderr: '',
        },
        'git rev-parse --show-toplevel': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: this operation must be run in a work tree',
        },
        'git submodule status': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: no git dir',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.repoRoot).toBe('');
      expect(out.result.submodules).toEqual([]);
      expect(out.result.clean).toBe(true);
    }
  });
});

describe('git wait rejection cleanup (issue #432)', () => {
  // RED first: untrack and clearTimeout sit after the await, so a
  // rejecting wait() leaks both the timer and the registry entry.
  it('clears the timer and untracks the handle when wait() rejects', async () => {
    let kills = 0;
    let untracked = 0;
    let removed = 0;
    const controller = new AbortController();
    const signal = controller.signal;
    const origRemove = signal.removeEventListener.bind(signal);
    signal.removeEventListener = ((...args: unknown[]) => {
      removed += 1;
      return (origRemove as (...a: never[]) => void)(...(args as never[]));
    }) as typeof signal.removeEventListener;
    const env = {
      shell: {
        spawn: () => ({
          wait: async () => {
            throw new Error('wait blew up');
          },
          kill: () => {
            kills += 1;
          },
        }),
      },
    } as unknown as import('../../../exec/src/env.js').ExecutionEnv;
    const context: OpContext = {
      env,
      sessionId: 's1',
      agentId: 'root',
      signal,
      trackHandle: () => () => {
        untracked += 1;
      },
    };
    await expect(
      runGit(context, inv(), 'git_status', ['status'], { timeoutSec: 0.05 }),
    ).rejects.toThrow('wait blew up');
    expect(untracked).toBe(1);
    expect(removed).toBe(1);
    // The 50 ms timer must be gone: nothing kills after the settle.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(kills).toBe(0);
  });
});

describe('git clipped results carry a stat summary (issue #432)', () => {
  // RED first: a clipped result names truncated + spill but says nothing
  // about what was cut.
  function strictCtx(
    scripts: Record<
      string,
      { exitCode: number; stdout: string; stderr: string }
    >,
  ): OpContext {
    return {
      env: new FakeExecutionEnv(scripts, { strict: true }),
      sessionId: 's1',
      agentId: 'root',
    };
  }

  const big = `${'line\n'.repeat(2500)}`;
  const statOut =
    ' a.txt | 2500 +++++++++++++++++++++++++++++++++++++++++++++++++\n b.txt | 10 +++++-----\n 2 files changed, 2505 insertions(+), 5 deletions(-)\n';

  it('git_diff attaches a stat summary only when clipped', async () => {
    const clipped = await callOperation(
      'git_diff',
      {},
      inv(),
      strictCtx({
        'git diff': { exitCode: 0, stdout: big, stderr: '' },
        'git diff --stat': { exitCode: 0, stdout: statOut, stderr: '' },
      }),
    );
    expect(clipped.ok).toBe(true);
    if (clipped.ok) {
      expect(clipped.result.truncated).toBe(true);
      expect(clipped.result.stat).toContain('a.txt');
      expect(clipped.result.stat).toContain('2 files changed');
    }
    const small = await callOperation(
      'git_diff',
      {},
      inv(),
      strictCtx({
        'git diff': { exitCode: 0, stdout: 'small\n', stderr: '' },
      }),
    );
    expect(small.ok).toBe(true);
    // Strict fake: a --stat spawn would throw, so passing proves the
    // unclipped result issues no second query — and carries no stat.
    if (small.ok) expect(small.result.stat).toBe(undefined);
  });

  it('git_show attaches a stat summary when clipped', async () => {
    const out = await callOperation(
      'git_show',
      { ref: 'HEAD' },
      inv(),
      strictCtx({
        'git show --format= --patch HEAD': {
          exitCode: 0,
          stdout: big,
          stderr: '',
        },
        'git show --format= --stat HEAD': {
          exitCode: 0,
          stdout: statOut,
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.stat).toContain('2 files changed');
  });

  it('git_log attaches a stat summary when clipped', async () => {
    const out = await callOperation(
      'git_log',
      {},
      inv(),
      strictCtx({
        'git log --format=%H%x1f%an%x1f%ad%x1f%s --date=short -n 20': {
          exitCode: 0,
          stdout: big,
          stderr: '',
        },
        'git log --stat --format=%H%x1f%an%x1f%ad%x1f%s --date=short -n 20': {
          exitCode: 0,
          stdout: statOut,
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.stat).toContain('a.txt');
  });

  it('a failing stat query never fails the op', async () => {
    const out = await callOperation(
      'git_diff',
      {},
      inv(),
      strictCtx({
        'git diff': { exitCode: 0, stdout: big, stderr: '' },
        'git diff --stat': { exitCode: 128, stdout: '', stderr: 'boom' },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.truncated).toBe(true);
      expect(out.result.stat).toBe(undefined);
    }
  });

  it('caps a huge stat at forty lines keeping the summary', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ` f${i}.txt | 1 +`).join(
      '\n',
    );
    const out = await callOperation(
      'git_diff',
      {},
      inv(),
      strictCtx({
        'git diff': { exitCode: 0, stdout: big, stderr: '' },
        'git diff --stat': {
          exitCode: 0,
          stdout: `${rows}\n 60 files changed, 60 insertions(+)\n`,
          stderr: '',
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const lines = (out.result.stat ?? '').split('\n');
      expect(lines.length).toBeLessThanOrEqual(41);
      expect(out.result.stat).toContain('60 files changed');
      expect(out.result.stat).toMatch(/more stat lines/);
    }
  });
});

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
      ]);
      expect(out.result.unstaged).toEqual(['unstaged.txt', 'both.txt']);
      // Issue #380: a conflicted path lives in conflicts only — it is
      // neither staged nor unstaged work.
      expect(out.result.conflicts).toEqual(['conflict.txt']);
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
      ctx({
        'git diff': { exitCode: 0, stdout: big, stderr: '' },
        // Issue #432: a clipped result also queries its --stat twin.
        'git diff --stat': {
          exitCode: 0,
          stdout: ' big.bin | 1 +\n 1 file changed, 1 insertion(+)\n',
          stderr: '',
        },
      }),
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
        // Issue #432: a clipped result also queries its --stat twin.
        'git show --format= --stat HEAD': {
          exitCode: 0,
          stdout: ' big.bin | 1 +\n 1 file changed, 1 insertion(+)\n',
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
        'git show --format= --stat HEAD': {
          exitCode: 0,
          stdout: ' big.bin | 1 +\n 1 file changed, 1 insertion(+)\n',
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
        'git log --stat --format=%H%x1f%an%x1f%ad%x1f%s --date=short -n 20': {
          exitCode: 0,
          stdout: ' a.txt | 1 +\n 1 file changed, 1 insertion(+)\n',
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
