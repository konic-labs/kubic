// `kubic replay` at declared determinism tiers. Faux-only: the re-execution
// runner is injected (zero network); trajectory fixtures are built with the
// versioned exporter so tests always run against the current stable contract.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { fixtureTrajectory } from '../test-support/replay-trajectory.js';
import {
  type ReplayCommandDeps,
  type ReplayCommandOptions,
  type ReplayRunResult,
  runReplayCommand,
} from './index.js';

// stdout (`lines`) and stderr (`errs`) captured separately.
interface Capture {
  lines: string[];
  errs: string[];
  write: (line: string) => void;
  err: (line: string) => void;
}

function out(): Capture {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    write: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
}

function writeTrajectory(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(fixtureTrajectory()));
  return path;
}

function writeLockfile(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({ models: { 'acme/m1': { digest: 'sha256:abc' } } }),
  );
  return path;
}

function deps(o: Capture, run?: ReplayCommandDeps['run']): ReplayCommandDeps {
  return {
    out: o.write,
    err: o.err,
    run:
      run ??
      (async (): Promise<ReplayRunResult> => {
        throw new Error('runner must not be called');
      }),
  };
}

describe('replay live', () => {
  // --role-config is the pin artifact naming the role the
  // re-execution boots as (`{"role": "<name>"}`); the role document itself
  // lives at `.kubic/roles/<name>.md` in the pinned worktree.
  function writeRoleConfig(dir: string, name: string, body?: string): string {
    const path = join(dir, name);
    writeFileSync(path, body ?? JSON.stringify({ role: 'implementer' }));
    return path;
  }

  it('refuses without a pinned role config (exit 2, runner never called)', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const o = out();
    let called = false;
    const exit = (
      await runReplayCommand(
        { trajectory: traj, tier: 'live', json: true },
        {
          out: o.write,
          err: o.err,
          run: async () => {
            called = true;
            return { terminus: 'completed', summary: 'must not run' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(called).toBe(false);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      tier: string;
      error: { code: string };
    };
    expect(envelope.tier).toBe('live');
    expect(envelope.error.code).toBe('live-needs-role-config');
  });

  it('refuses model/lockfile pins under live (pins come from the role)', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const lock = writeLockfile(dir, 'pins.json');
    for (const extra of [{ model: 'acme/m1' }, { lockfile: lock }]) {
      const o = out();
      const exit = (
        await runReplayCommand(
          { trajectory: traj, tier: 'live', roleConfig: role, ...extra },
          deps(o),
        )
      ).exitCode;
      expect(exit).toBe(2);
      expect(o.lines).toEqual([]);
      expect(o.errs.join('\n')).toMatch(
        /^error: \[unexpected-flag-for-tier\] /,
      );
    }
  });

  it('exits 5 when the role config is unreadable', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'live',
          roleConfig: join(dir, 'missing.md'),
          json: true,
        },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(5);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('role-config-unreadable');
  });

  it('exits 2 when the role config is empty', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'empty.md', '   \n');
    const o = out();
    const exit = (
      await runReplayCommand(
        { trajectory: traj, tier: 'live', roleConfig: role },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/^error: \[role-config-invalid\] /);
  });

  it('re-executes live: tier live, invocation live-exact, runner gets role config', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const seen: unknown[] = [];
    const o = out();
    const exit = (
      await runReplayCommand(
        { trajectory: traj, tier: 'live', roleConfig: role, json: true },
        {
          out: o.write,
          err: o.err,
          run: async (request) => {
            seen.push(request);
            return { terminus: 'completed', summary: 'live ok' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      tier: 'live',
      roleConfig: role,
      role: 'implementer',
      model: 'acme/m1',
    });
    const envelope = JSON.parse(o.lines.join('\n')) as {
      tier: string;
      invocation: string;
    };
    expect(envelope.tier).toBe('live');
    expect(envelope.invocation).toBe('live-exact');
  });

  it('live with --worktree override is a different-worktree invocation (experimental)', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const wt = tempDir('replay-wt-');
    const seen: unknown[] = [];
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'live',
          roleConfig: role,
          worktree: wt,
          json: true,
        },
        {
          out: o.write,
          err: o.err,
          run: async (request) => {
            seen.push(request);
            return { terminus: 'completed', summary: 'live ok' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen[0]).toMatchObject({ worktree: wt, tier: 'live' });
    const envelope = JSON.parse(o.lines.join('\n')) as {
      invocation: string;
      changed: string[];
      experimental: string[];
    };
    expect(envelope.invocation).toBe('different-worktree');
    expect(envelope.changed).toEqual(['worktree']);
    expect(envelope.experimental).toEqual(['worktree']);
  });
});

describe('replay compare/regression (diff-against)', () => {
  function writeVariant(dir: string, name: string, variant: string): string {
    const path = join(dir, name);
    const base = fixtureTrajectory();
    if (variant === 'same') writeFileSync(path, JSON.stringify(base));
    else if (variant === 'model') {
      writeFileSync(
        path,
        JSON.stringify({ ...base, model: { ...base.model, model: 'm2' } }),
      );
    } else if (variant === 'worktree-diff') {
      writeFileSync(
        path,
        JSON.stringify({
          ...base,
          worktree: { ...base.worktree, path: '/other/wt' },
          diff: {
            filesChanged: ['a.ts', 'b.ts'],
            files: [
              { path: 'a.ts', hunks: ['@@ -1 +1 @@'] },
              { path: 'b.ts', hunks: ['@@ -1 +1 @@'] },
            ],
          },
        }),
      );
    }
    return path;
  }

  it('identical trajectories: exit 0, changed empty, regression false, runner never called', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const other = writeVariant(dir, 'other.json', 'same');
    const o = out();
    let called = false;
    const exit = (
      await runReplayCommand(
        { trajectory: traj, diffAgainst: other, json: true },
        {
          out: o.write,
          err: o.err,
          run: async () => {
            called = true;
            return { terminus: 'completed', summary: 'must not run' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(called).toBe(false);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      tier: string;
      invocation: string;
      changed: string[];
      regression: boolean;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.tier).toBe('recorded');
    expect(envelope.invocation).toBe('compare');
    expect(envelope.changed).toEqual([]);
    expect(envelope.regression).toBe(false);
  });

  it('names each changed var and exits 1 as the regression signal', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    for (const [variant, want] of [
      ['model', ['model']],
      ['worktree-diff', ['worktree', 'diff']],
    ] as const) {
      const other = writeVariant(dir, `${variant}.json`, variant);
      const o = out();
      const exit = (
        await runReplayCommand(
          { trajectory: traj, diffAgainst: other, json: true },
          deps(o),
        )
      ).exitCode;
      expect(exit).toBe(1);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        changed: string[];
        regression: boolean;
        tier: string;
        invocation: string;
      };
      expect(envelope.changed).toEqual([...want]);
      expect(envelope.regression).toBe(true);
      expect(envelope.tier).toBe('recorded');
      expect(envelope.invocation).toBe('compare');
    }
  });

  it('prints the changed vars in text output', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const other = writeVariant(dir, 'other.json', 'model');
    const o = out();
    const exit = (
      await runReplayCommand({ trajectory: traj, diffAgainst: other }, deps(o))
    ).exitCode;
    expect(exit).toBe(1);
    const text = o.lines.join('\n');
    expect(text).toMatch(/tier: recorded/);
    expect(text).toMatch(/changed: model/);
    expect(text).toMatch(/regression: true/);
  });

  it('exits 5 when the --diff-against file is unreadable, 2 when malformed', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const missing = out();
    const exitMissing = (
      await runReplayCommand(
        {
          trajectory: traj,
          diffAgainst: join(dir, 'missing.json'),
          json: true,
        },
        deps(missing),
      )
    ).exitCode;
    expect(exitMissing).toBe(5);
    expect(
      (JSON.parse(missing.lines.join('\n')) as { error: { code: string } })
        .error.code,
    ).toBe('diff-against-unreadable');
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{oops');
    const bad = out();
    const exitBad = (
      await runReplayCommand(
        { trajectory: traj, diffAgainst: badPath, json: true },
        deps(bad),
      )
    ).exitCode;
    expect(exitBad).toBe(2);
    expect(
      (JSON.parse(bad.lines.join('\n')) as { error: { code: string } }).error
        .code,
    ).toBe('diff-against-malformed');
  });

  it('refuses --diff-against under re-execution tiers', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const other = writeVariant(dir, 'other.json', 'same');
    const lock = writeLockfile(dir, 'pins.json');
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: lock,
          diffAgainst: other,
        },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/^error: \[unexpected-flag-for-tier\] /);
  });
});

describe('replay tier honesty (negative tests)', () => {
  it('recorded refuses execution flags — it replays the trajectory alone', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    for (const extra of [
      { model: 'acme/m1' },
      { worktree: dir },
      { lockfile: writeLockfile(dir, 'pins.json') },
    ]) {
      const o = out();
      const exit = (
        await runReplayCommand(
          { trajectory: traj, ...extra, json: true },
          deps(o),
        )
      ).exitCode;
      expect(exit).toBe(2);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        tier: string;
        error: { code: string };
      };
      expect(envelope.tier).toBe('recorded');
      expect(envelope.error.code).toBe('recorded-takes-trajectory-alone');
    }
  });

  it('the published tier always equals the declared tier (never inflated)', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    const rolePath = join(dir, 'role.json');
    writeFileSync(rolePath, JSON.stringify({ role: 'implementer' }));
    const cases: { args: ReplayCommandOptions; tier: string; exit: number }[] =
      [
        { args: { trajectory: traj }, tier: 'recorded', exit: 0 },
        {
          args: {
            trajectory: traj,
            tier: 'deterministic',
            model: 'acme/m1',
            lockfile: lock,
          },
          tier: 'deterministic',
          exit: 0,
        },
        {
          args: { trajectory: traj, tier: 'live', roleConfig: rolePath },
          tier: 'live',
          exit: 0,
        },
        {
          args: { trajectory: traj, tier: 'deterministic' },
          tier: 'deterministic',
          exit: 2,
        },
        { args: { trajectory: traj, tier: 'live' }, tier: 'live', exit: 2 },
      ];
    for (const { args, tier, exit } of cases) {
      const o = out();
      const got = (
        await runReplayCommand(
          { ...args, json: true },
          {
            out: o.write,
            err: o.err,
            run: async () => ({ terminus: 'completed', summary: 'ok' }),
          },
        )
      ).exitCode;
      expect(got).toBe(exit);
      const envelope = JSON.parse(o.lines.join('\n')) as { tier: string };
      expect(envelope.tier).toBe(tier);
    }
  });

  it('rejects lockfiles that are not a pinned models record', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const notJson = join(dir, 'not-json.json');
    writeFileSync(notJson, 'nope');
    const noModels = join(dir, 'no-models.json');
    writeFileSync(noModels, JSON.stringify({ models: {} }));
    for (const lock of [notJson, noModels]) {
      const o = out();
      const exit = (
        await runReplayCommand(
          {
            trajectory: traj,
            tier: 'deterministic',
            model: 'acme/m1',
            lockfile: lock,
            json: true,
          },
          deps(o),
        )
      ).exitCode;
      expect(exit).toBe(2);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        error: { code: string };
      };
      expect(envelope.error.code).toBe('lockfile-invalid');
    }
  });

  it('rejects an unknown --tier and a missing --worktree target', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    const badTier = out();
    const exitTier = (
      await runReplayCommand(
        { trajectory: traj, tier: 'ultra', json: true },
        deps(badTier),
      )
    ).exitCode;
    expect(exitTier).toBe(2);
    expect(
      (JSON.parse(badTier.lines.join('\n')) as { tier: string }).tier,
    ).toBe('unknown');
    const badWt = out();
    const exitWt = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: lock,
          worktree: join(dir, 'missing-wt'),
          json: true,
        },
        deps(badWt),
      )
    ).exitCode;
    expect(exitWt).toBe(5);
    expect(
      (JSON.parse(badWt.lines.join('\n')) as { error: { code: string } }).error
        .code,
    ).toBe('worktree-unavailable');
  });

  it('deterministic --worktree success names worktree as the changed var (experimental)', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    const wt = tempDir('replay-wt-');
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: lock,
          worktree: wt,
        },
        {
          out: o.write,
          err: o.err,
          run: async () => ({ terminus: 'completed', summary: 'ok' }),
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    // The experimental warning is a diagnostic (stderr); the report is data.
    expect(o.errs).toEqual(['warn: --worktree is experimental']);
    expect(o.lines.join('\n')).toMatch(/invocation: different-worktree/);
  });
});

// Argv syntax errors (a missing value, an unknown flag, a second operand)
// are commander's — one `error: …` line on stderr, exit 2, pinned in
// apps/kubic/src/commands/analysis.test.ts. The handler keeps the tiered
// envelope for the semantic refusals below.
describe('replay semantic-error envelopes (exit 2 with tier; --json)', () => {
  it('emits a tiered envelope when the trajectory is missing', async () => {
    const o = out();
    const exit = (await runReplayCommand({ json: true }, deps(o))).exitCode;
    expect(exit).toBe(2);
    expect(o.errs).toEqual([]);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      tier: string;
      invocation: null;
      trajectory: null;
      changed: string[];
      error: { code: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      exitCode: 2,
      tier: 'recorded',
      invocation: null,
      trajectory: null,
      changed: [],
    });
    expect(envelope.error.code).toBe('missing-trajectory');
  });

  it('names the missing trajectory on stderr off --json', async () => {
    const o = out();
    const exit = (await runReplayCommand({}, deps(o))).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs).toEqual([
      'error: [missing-trajectory] missing required argument <trajectory.json>',
    ]);
  });

  it('publishes tier unknown when --tier names an unknown tier', async () => {
    const dir = tempDir();
    const traj = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = (
      await runReplayCommand(
        { trajectory: traj, tier: 'ultra', json: true },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      tier: string;
      error: { code: string };
    };
    expect(envelope.tier).toBe('unknown');
    expect(envelope.error.code).toBe('invalid-tier');
  });
});
