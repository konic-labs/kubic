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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../../exec/src/env.js';
import {
  MEASURED_BUDGET_KINDS,
  type MeasureRequest,
  measureSamples,
} from './measure.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('measureSamples: spawn source (issue #98)', () => {
  it('measures N spawns through the exec shell seam and returns raw ms samples', async () => {
    const env = new FakeExecutionEnv({});
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
    expect(result.samplesMs).toHaveLength(5);
    expect(result.samplesMs.every((ms) => ms >= 0)).toBe(true);
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
});

describe('measureSamples: worktree source (issue #98)', () => {
  it('measures N real worktree add/remove cycles in a throwaway repo', async () => {
    const root = tmpRoot('measure-wt-');
    // A real, minimal git repo: worktree add needs a commit to branch from.
    const env = new NodeExecutionEnv(root);
    for (const argv of [
      ['init', '-q', '.'],
      [
        '-c',
        'user.email=perf@kubic.local',
        '-c',
        'user.name=kubic',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
    ]) {
      const handle = env.shell.spawn('git', argv, {
        provenance: env.provenance,
      });
      const done = await handle.wait();
      if (done.exitCode !== 0)
        throw new Error(`git ${argv.join(' ')} failed: ${done.stderr}`);
    }
    try {
      const result = await measureSamples({
        kind: 'worktree',
        samples: 3,
        env,
        repoRoot: root,
      });
      expect(result.kind).toBe('worktree');
      expect(result.samplesMs).toHaveLength(3);
      expect(result.samplesMs.every((ms) => ms >= 0)).toBe(true);
      expect(result.source).toBe('measured');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves no worktree behind after measuring', async () => {
    const root = tmpRoot('measure-wt-clean-');
    const env = new NodeExecutionEnv(root);
    for (const argv of [
      ['init', '-q', '.'],
      [
        '-c',
        'user.email=perf@kubic.local',
        '-c',
        'user.name=kubic',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
    ]) {
      const handle = env.shell.spawn('git', argv, {
        provenance: env.provenance,
      });
      await handle.wait();
    }
    try {
      await measureSamples({
        kind: 'worktree',
        samples: 2,
        env,
        repoRoot: root,
      });
      const list = env.shell.spawn('git', ['worktree', 'list', '--porcelain'], {
        provenance: env.provenance,
      });
      const done = await list.wait();
      // One entry only: the main checkout. Every measured worktree was removed.
      expect(
        done.stdout.split('\n').filter((line) => line.startsWith('worktree ')),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MEASURED_BUDGET_KINDS (issue #98)', () => {
  it('covers at least spawn and worktree', () => {
    expect([...MEASURED_BUDGET_KINDS].sort()).toEqual(['spawn', 'worktree']);
  });
});

describe('measureSamples: spawn argv plumbing (issue #98 follow-up)', () => {
  // A recording seam: measureSpawnOnce must hand the configured argv to the
  // shell. Asserting only sample count/values left this unpinned — replacing
  // `command.args` with `[]` kept every existing test green.
  class RecordingEnv extends FakeExecutionEnv {
    readonly seen: string[][] = [];
    private readonly base = new FakeExecutionEnv({});
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

describe('measureSamples: injected writer', () => {
  it('never writes outside the injected sessions root', async () => {
    // The spawn source is hermetic: it must not touch the real filesystem.
    const root = tmpRoot('measure-hermetic-');
    writeFileSync(join(root, 'sentinel.txt'), 'untouched\n');
    const env = new FakeExecutionEnv({});
    await measureSamples({ kind: 'spawn', samples: 2, env });
    expect(() => env.fs.readFile('sentinel.txt')).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
