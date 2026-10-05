// The run verifier (issue #267; §48 gate signals, §74 Trajectory → Verifier
// → Reward). Configured gate commands run through the exec seam in the
// run's worktree: exit 0 is pass, anything else (a timeout included) is
// fail, an unconfigured gate is absent (unknown). Real temp dirs and local
// shell builtins only — no network.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../exec/src/env.js';
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  hasVerifyCommands,
  runVerifier,
  VERIFY_GATES,
  verifierLabels,
} from './verifier.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verifier-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runVerifier (issue #267)', () => {
  it('maps exit 0 to pass and a non-zero exit to fail, in the worktree', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'ok.txt'), 'yes\n');
    const results = await runVerifier(new NodeExecutionEnv(dir), {
      tests: 'test -f ok.txt',
      lint: 'test -f missing.txt',
    });
    expect(results).toEqual({ tests: 'pass', lint: 'fail' });
  });

  it('leaves an unconfigured (or blank) gate out — it stays unknown', async () => {
    const results = await runVerifier(new NodeExecutionEnv(tmp()), {
      build: '   ',
    });
    expect(results).toEqual({});
  });

  it('fails a command that outlives its timeout, and kills it', {
    timeout: 20_000,
  }, async () => {
    const dir = tmp();
    const started = Date.now();
    const results = await runVerifier(
      new NodeExecutionEnv(dir),
      { typecheck: 'sleep 5; touch late.txt' },
      { timeoutMs: 200 },
    );
    expect(results).toEqual({ typecheck: 'fail' });
    expect(Date.now() - started).toBeLessThan(4_000);
    // Killed, not merely abandoned: the late write never lands.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(existsSync(join(dir, 'late.txt'))).toBe(false);
  });

  it('runs the gates in the documented order', () => {
    expect(VERIFY_GATES).toEqual(['tests', 'build', 'lint', 'typecheck']);
  });

  it('defaults a gate bound to ten minutes and asks the exec seam for sh -c', async () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(10 * 60 * 1000);
    const seen: { args: string[]; maxOutputBytes: unknown }[] = [];
    const env = new FakeExecutionEnv({});
    const spy: ExecutionEnv = {
      cwd: env.cwd,
      fs: env.fs,
      provenance: env.provenance,
      withProvenance: (next) => env.withProvenance(next),
      shell: {
        spawn: (cmd, args, options) => {
          seen.push({
            args: [cmd, ...args],
            maxOutputBytes: options.maxOutputBytes,
          });
          return env.shell.spawn(cmd, args, options);
        },
      },
    };
    const results = await runVerifier(spy, { tests: 'true' });
    expect(results).toEqual({ tests: 'pass' });
    expect(seen).toEqual([
      { args: ['sh', '-c', 'true'], maxOutputBytes: 64 * 1024 },
    ]);
  });

  it('fails a gate whose command cannot be spawned at all', async () => {
    const env = new FakeExecutionEnv({});
    const broken: ExecutionEnv = {
      cwd: env.cwd,
      fs: env.fs,
      provenance: env.provenance,
      withProvenance: (next) => env.withProvenance(next),
      shell: {
        spawn: () => {
          throw new Error('spawn ENOENT');
        },
      },
    };
    const results = await runVerifier(broken, { build: 'make' });
    expect(results).toEqual({ build: 'fail' });
  });

  it('treats a command killed at its bound as fail even when it exits 0 afterwards', async () => {
    const base = new FakeExecutionEnv({});
    let settle: (() => void) | undefined;
    const hanging: ExecutionEnv = {
      cwd: base.cwd,
      fs: base.fs,
      provenance: base.provenance,
      withProvenance: (next) => base.withProvenance(next),
      shell: {
        spawn: () => ({
          pid: undefined,
          wait: () =>
            new Promise((resolve) => {
              settle = () =>
                resolve({
                  exitCode: 0,
                  stdout: '',
                  stderr: '',
                  provenance: base.provenance,
                });
            }),
          kill: () => settle?.(),
        }),
      },
    };
    const results = await runVerifier(
      hanging,
      { lint: 'hang' },
      { timeoutMs: 10 },
    );
    expect(results).toEqual({ lint: 'fail' });
  });

  it('hasVerifyCommands is true only with at least one non-blank command', () => {
    expect(hasVerifyCommands(undefined)).toBe(false);
    expect(hasVerifyCommands({})).toBe(false);
    expect(hasVerifyCommands({ tests: '' })).toBe(false);
    expect(hasVerifyCommands({ tests: '   ' })).toBe(false);
    expect(hasVerifyCommands({ lint: 'biome ci .' })).toBe(true);
  });
});

describe('verifierLabels (issue #267)', () => {
  it('writes signal:<gate> for every verified gate', () => {
    expect(verifierLabels({ tests: 'pass', build: 'fail' })).toEqual({
      'signal:tests': 'pass',
      'signal:build': 'fail',
    });
  });

  it('flags a regression when a gate that passed at base fails now', () => {
    expect(
      verifierLabels({ tests: 'fail' }, { tests: 'pass' })['signal:regression'],
    ).toBe('fail');
  });

  it('a gate already red at base, or still green, is no regression', () => {
    expect(
      verifierLabels({ tests: 'fail' }, { tests: 'fail' })['signal:regression'],
    ).toBe('pass');
    expect(
      verifierLabels(
        { tests: 'pass', lint: 'pass' },
        { tests: 'pass', lint: 'fail' },
      )['signal:regression'],
    ).toBe('pass');
  });

  it('flags a regression when any compared gate regressed, even beside a stable one', () => {
    expect(
      verifierLabels(
        { tests: 'fail', lint: 'pass' },
        { tests: 'pass', lint: 'pass' },
      )['signal:regression'],
    ).toBe('fail');
  });

  it('says nothing about regression without a comparable baseline', () => {
    expect(verifierLabels({ tests: 'pass' })).not.toHaveProperty(
      'signal:regression',
    );
    expect(
      verifierLabels({ tests: 'pass' }, { lint: 'pass' }),
    ).not.toHaveProperty('signal:regression');
    expect(Object.keys(verifierLabels({}, {}))).toEqual([]);
  });
});
