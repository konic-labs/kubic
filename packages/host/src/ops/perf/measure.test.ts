// Real perf measurements for `kubic perf` (issue #98, criterion 2): the
// budget can be evaluated over MEASURED samples instead of operator-supplied
// argv numbers, with the sample mode kept as the explicit fallback.
// Two measurement sources, both offline:
//   - `spawn`: repeated in-process spawns through the exec Shell seam
//     (FakeExecutionEnv in tests, NodeExecutionEnv in prod) — measures the
//     readiness-marker latency the §61 budget is about;
//   - `worktree`: repeated `git worktree add`+remove cycles through an
//     injected ExecutionEnv (a real throwaway repo in tests).
// Faux-only where it matters: the spawn source is hermetic; the worktree
// source takes an injected env so a test can use the fake seam.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import { openSessionStore } from '../../../../worker/src/lane/session-store.js';
import {
  MEASURED_BUDGET_KINDS,
  MeasureError,
  type MeasureRequest,
  measureSamples,
} from './measure.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('measureSamples: spawn source (issue #98)', () => {
  it('measures N spawns through the exec shell seam and returns raw ms samples', async () => {
    // Unscripted spawn answers are irrelevant here (fake clock pins the
    // samples); opt out of strict mode explicitly (issue #356).
    const env = new FakeExecutionEnv({}, { allowUnscripted: true });
    const request: MeasureRequest = {
      kind: 'spawn',
      samples: 5,
      env,
      clock: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })(),
    };
    const result = await measureSamples(request);
    expect(result.kind).toBe('spawn');
    // The injected clock ticks 10ms per read and each sample reads it once
    // before and once after the spawn: every sample is exactly one tick.
    expect(result.samplesMs).toEqual([10, 10, 10, 10, 10]);
    expect(result.source).toBe('measured');
  });

  it('rejects a non-positive sample count instead of a vacuous pass', async () => {
    await expect(
      measureSamples({
        kind: 'spawn',
        samples: 0,
        env: new FakeExecutionEnv({}),
      }),
    ).rejects.toThrow(/at least one sample/i);
  });

  it('refuses a budget kind with no live measurement source', async () => {
    await expect(
      measureSamples({
        kind: 'attach',
        samples: 1,
        env: new FakeExecutionEnv({}),
      }),
    ).rejects.toThrow(MeasureError);
  });
});

describe('measureSamples: worktree source (issue #98)', () => {
  // One real throwaway repo, two measured cycles: every real git spawn costs
  // wall-clock time, so the measurement and its cleanup share one run.
  it('measures N real worktree add/remove cycles and leaves no worktree behind', async () => {
    const root = tmpRoot('measure-wt-');
    const env = new NodeExecutionEnv(root);
    const git = async (argv: string[]) => {
      const done = await env.shell
        .spawn('git', argv, { provenance: env.provenance })
        .wait();
      if (done.exitCode !== 0)
        throw new Error(`git ${argv.join(' ')} failed: ${done.stderr}`);
      return done.stdout;
    };
    try {
      // worktree add needs a commit to branch from.
      await git(['init', '-q', '.']);
      await git([
        '-c',
        'user.email=perf@kubic.local',
        '-c',
        'user.name=kubic',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ]);
      const result = await measureSamples({
        kind: 'worktree',
        samples: 2,
        env,
        repoRoot: root,
      });
      expect(result.kind).toBe('worktree');
      expect(result.samplesMs).toHaveLength(2);
      expect(result.samplesMs.every((ms) => ms >= 0)).toBe(true);
      expect(result.source).toBe('measured');
      // One entry only: the main checkout. Every measured worktree was removed.
      const list = await git(['worktree', 'list', '--porcelain']);
      expect(
        list.split('\n').filter((line) => line.startsWith('worktree ')),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Eight real git spawns: headroom for a loaded CI box, not a sleep.
  }, 15_000);
});

describe('MEASURED_BUDGET_KINDS (issue #98, #158)', () => {
  it('covers spawn, worktree and attach — teardown stays sample-only', () => {
    expect([...MEASURED_BUDGET_KINDS].sort()).toEqual([
      'attach',
      'spawn',
      'worktree',
    ]);
    expect([...MEASURED_BUDGET_KINDS]).not.toContain('teardown');
  });
});

describe('measureSamples: attach cycles (issue #158)', () => {
  it('measures real create/attach cycles and leaves no session behind', async () => {
    const root = tmpRoot('perf-attach-');
    const store = openSessionStore(root, createNodeFileBridge(root));
    const samples = await measureSamples({
      kind: 'attach',
      samples: 2,
      env: new FakeExecutionEnv({}),
      sessionStore: store,
    });
    expect(samples.kind).toBe('attach');
    expect(samples.source).toBe('measured');
    expect(samples.samplesMs).toHaveLength(2);
    for (const ms of samples.samplesMs) expect(ms).toBeGreaterThanOrEqual(0);
    expect(samples.note).toContain('create/attach cycle');
    // Cleanup: the measurement's own sessions are gone, and no lock is held.
    expect(
      store.bridge
        .listDir(root)
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('perf-')),
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses attach without a sessions root instead of fabricating a sample', async () => {
    await expect(
      measureSamples({
        kind: 'attach',
        samples: 1,
        env: new FakeExecutionEnv({}),
      }),
    ).rejects.toThrow(/needs a sessions root/);
  });
});

describe('measureSamples: spawn argv plumbing (issue #98 follow-up)', () => {
  // A recording seam: measureSpawnOnce must hand the configured argv to the
  // shell. Asserting only sample count/values left this unpinned — replacing
  // `command.args` with `[]` kept every existing test green.
  class RecordingEnv extends FakeExecutionEnv {
    readonly seen: string[][] = [];
    // The inner fake only records argv; answers never matter.
    private readonly base = new FakeExecutionEnv({}, { allowUnscripted: true });
    override readonly shell = {
      spawn: (
        cmd: string,
        args: string[],
        options: Parameters<ExecutionEnv['shell']['spawn']>[2],
      ) => {
        this.seen.push([cmd, ...args]);
        return this.base.shell.spawn(cmd, args, options);
      },
    };
  }

  it('passes the requested argv through to the spawned child', async () => {
    const env = new RecordingEnv({});
    await measureSamples({
      kind: 'spawn',
      samples: 2,
      env,
      spawnCommand: { cmd: 'node', args: ['-e', 'process.exit(0)'] },
    });
    expect(env.seen).toHaveLength(2);
    expect(env.seen[0]).toEqual(['node', '-e', 'process.exit(0)']);
  });

  it('defaults to a real, argument-bearing node one-liner', async () => {
    const env = new RecordingEnv({});
    await measureSamples({ kind: 'spawn', samples: 1, env });
    expect(env.seen).toHaveLength(1);
    // The default measures process-start latency, so it must carry argv —
    // an empty argv would still "pass" while measuring a bare interpreter.
    expect(env.seen[0]?.[0]).toBe(process.execPath);
    expect(env.seen[0]?.[1]).toBe('-e');
    expect(env.seen[0]?.[2]).toBe('0');
  });
});

describe('measureSamples: hermetic spawn source', () => {
  it('writes nothing through the injected env filesystem', async () => {
    // The spawn answers never matter; only filesystem silence is pinned.
    const env = new FakeExecutionEnv({}, { allowUnscripted: true });
    await measureSamples({ kind: 'spawn', samples: 2, env });
    expect(env.fs.listDir('')).toEqual([]);
  });
});

describe('measureSamples: worktree failure (issue #98)', () => {
  it('fails loudly when git worktree add fails instead of recording a sample', async () => {
    const path = `/repo/.kubic/wt/perf-0-${process.pid}`;
    const env = new FakeExecutionEnv({
      [`git worktree add ${path} -b kubic/perf-0-${process.pid}`]: {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    });
    await expect(
      measureSamples({ kind: 'worktree', samples: 1, env, repoRoot: '/repo' }),
    ).rejects.toThrow(/worktree add failed.*exit 128.*not a git repository/);
  });
});

describe('measureSamples: worktree/measure hygiene (issue #252)', () => {
  // Real git, like the #98 worktree test above: branch deletion and root
  // resolution only mean something against a real repository.
  async function initRepo(root: string): Promise<void> {
    const env = new NodeExecutionEnv(root);
    const git = async (argv: string[]) => {
      const done = await env.shell
        .spawn('git', argv, { provenance: env.provenance })
        .wait();
      if (done.exitCode !== 0)
        throw new Error(`git ${argv.join(' ')} failed: ${done.stderr}`);
      return done.stdout;
    };
    await git(['init', '-q', '.']);
    await git([
      '-c',
      'user.email=perf@kubic.local',
      '-c',
      'user.name=kubic',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    return undefined;
  }

  it('leaves no kubic/perf-* branch behind after --measure', async () => {
    const root = tmpRoot('measure-branches-');
    try {
      await initRepo(root);
      const env = new NodeExecutionEnv(root);
      await measureSamples({
        kind: 'worktree',
        samples: 2,
        env,
        repoRoot: root,
      });
      const branches = await env.shell
        .spawn('git', ['branch', '--list', 'kubic/perf-*'], {
          provenance: env.provenance,
        })
        .wait();
      expect(branches.stdout.trim()).toBe('');
      const list = await env.shell
        .spawn('git', ['worktree', 'list', '--porcelain'], {
          provenance: env.provenance,
        })
        .wait();
      expect(
        list.stdout.split('\n').filter((line) => line.startsWith('worktree ')),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Real git spawns: headroom for a loaded CI box, not a sleep.
  }, 15_000);

  it('measures from the repo root when run from a subdirectory', async () => {
    const root = tmpRoot('measure-subdir-');
    try {
      await initRepo(root);
      const sub = join(root, 'a', 'b');
      mkdirSync(sub, { recursive: true });
      const env = new NodeExecutionEnv(sub);
      await measureSamples({ kind: 'worktree', samples: 1, env });
      // The sample's worktree lived under the ROOT's .kubic/wt (already
      // removed by cleanup), so the negative proves the root resolution:
      // no state leaked into the subdirectory.
      const bridge = createNodeFileBridge('/');
      expect(bridge.exists(join(sub, '.kubic'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('a spawn command that exits non-zero is a measurement error', async () => {
    const cmd = process.execPath;
    const args = ['-e', 'process.exit(3)'];
    const env = new FakeExecutionEnv({
      [`${cmd} ${args.join(' ')}`]: {
        exitCode: 3,
        stdout: '',
        stderr: 'boom',
      },
    });
    await expect(
      measureSamples({
        kind: 'spawn',
        samples: 1,
        env,
        spawnCommand: { cmd, args },
      }),
    ).rejects.toThrow(/exit 3/);
  });

  it('a failed worktree remove is a measurement error, with the branch still deleted', async () => {
    const agentId = `perf-0-${process.pid}`;
    const path = `/fake/.kubic/wt/${agentId}`;
    const branch = `kubic/${agentId}`;
    const env = new FakeExecutionEnv(
      {
        [`git worktree add ${path} -b ${branch}`]: {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        [`git worktree remove --force ${path}`]: {
          exitCode: 1,
          stdout: '',
          stderr: 'remove failed',
        },
        [`git branch -D ${branch}`]: {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      },
      { strict: true },
    );
    await expect(
      measureSamples({ kind: 'worktree', samples: 1, env }),
    ).rejects.toThrow(/worktree remove/);
    // Cleanup was attempted even though the sample failed.
    expect(
      env.calls.some(
        (call) =>
          call.cmd === 'git' && call.args.join(' ') === `branch -D ${branch}`,
      ),
    ).toBe(true);
  });

  it('a failed branch delete is a measurement error', async () => {
    const agentId = `perf-0-${process.pid}`;
    const path = `/fake/.kubic/wt/${agentId}`;
    const branch = `kubic/${agentId}`;
    const env = new FakeExecutionEnv(
      {
        [`git worktree add ${path} -b ${branch}`]: {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        [`git worktree remove --force ${path}`]: {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        [`git branch -D ${branch}`]: {
          exitCode: 1,
          stdout: '',
          stderr: `error: branch '${branch}' not found`,
        },
      },
      { strict: true },
    );
    await expect(
      measureSamples({ kind: 'worktree', samples: 1, env }),
    ).rejects.toThrow(/branch -D/);
  });
});
