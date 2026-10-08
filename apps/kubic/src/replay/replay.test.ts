// `kubic replay` at declared determinism tiers. Faux-only: the re-execution
// runner is injected (zero network); trajectory fixtures are built with the
// versioned exporter so tests always run against the current stable contract.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReplayCommandDeps,
  type ReplayCommandOptions,
  type ReplayRunResult,
  runReplayCommand,
} from '../../../../packages/host/src/replay/replay.js';
import { buildTrajectoryExport } from '../../../../packages/trajectory/src/export.js';
import type { TrajectoryExport } from '../../../../packages/trajectory/src/schema.js';

const roots: string[] = [];

function tmpRoot(prefix = 'replay-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

export function fixtureTrajectory(
  overrides: Partial<TrajectoryExport> = {},
): TrajectoryExport {
  const base = buildTrajectoryExport({
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [
      { seq: 1, tool: 'read', args: { path: 'a.ts' } },
      { seq: 2, tool: 'edit', args: { path: 'a.ts' } },
    ],
    observations: [{ seq: 1, actionSeq: 1, output: 'hello' }],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      generation: 1,
      worktree: '/repo',
      model: 'acme/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo',
      env: {},
    },
    worktree: {
      path: '/repo',
      baseRevision: 'abc123',
      branch: null,
    },
    diff: {
      filesChanged: ['a.ts'],
      files: [{ path: 'a.ts', hunks: ['@@ -1 +1 @@'] }],
    },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:01:00.000Z',
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0.01,
      byModel: {},
    },
    result: {
      status: 'completed',
      summary: 'done',
      failureCategory: null,
      error: null,
    },
  });
  return { ...base, ...overrides };
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

describe('replay recorded exact (exact; Recorded)', () => {
  it('resolves a relative trajectory path against the working directory, not /', async () => {
    const dir = tmpRoot();
    writeTrajectory(dir, 'rel.json');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const o = out();
      const exit = (await runReplayCommand({ trajectory: 'rel.json' }, deps(o)))
        .exitCode;
      expect(o.lines.join('\n')).not.toMatch(/trajectory-unreadable/);
      expect(exit).toBe(0);
    } finally {
      cwd.mockRestore();
    }
  });

  it('replays a versioned trajectory log-only: exit 0, tier printed, runner never called', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    let called = false;
    const exit = (
      await runReplayCommand(
        { trajectory: path },
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
    const text = o.lines.join('\n');
    expect(text).toMatch(/tier: recorded/);
    expect(text).toMatch(/acme\/m1/);
    expect(text).toMatch(/result: completed/);
  });

  it('publishes the tier in the --json envelope', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = (
      await runReplayCommand({ trajectory: path, json: true }, deps(o))
    ).exitCode;
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      tier: string;
      invocation: string;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.tier).toBe('recorded');
    expect(envelope.invocation).toBe('exact');
  });

  it('exits 5 with a machine-readable code when the trajectory file is missing', async () => {
    const o = out();
    const exit = (
      await runReplayCommand(
        { trajectory: join(tmpRoot(), 'nope.json'), json: true },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(5);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('trajectory-unreadable');
  });

  it('exits 2 when the trajectory is malformed', async () => {
    const dir = tmpRoot();
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    const o = out();
    const exit = (
      await runReplayCommand({ trajectory: path, json: true }, deps(o))
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('trajectory-malformed');
  });

  it('exits 2 with trajectory-malformed when a trajectory section is structurally wrong', async () => {
    // Actions:null must not reach the describe/compare code and
    // die as a raw TypeError (generic exit 1). It is refused by the
    // parser with a named path, on the same exit-2 code as any other
    // malformed trajectory.
    const dir = tmpRoot();
    const path = join(dir, 'null-actions.json');
    writeFileSync(
      path,
      JSON.stringify({ ...fixtureTrajectory(), actions: null }),
    );
    const o = out();
    const exit = (
      await runReplayCommand({ trajectory: path, json: true }, deps(o))
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.errs).toEqual([]);
    expect(o.lines).toHaveLength(1);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.error.code).toBe('trajectory-malformed');
    expect(envelope.error.message).toMatch(
      /trajectory\.actions must be an array \(got null\)/,
    );
    // Text mode: one machine-readable `error: [code] message` line on stderr.
    const text = out();
    expect(
      (await runReplayCommand({ trajectory: path }, deps(text))).exitCode,
    ).toBe(2);
    expect(text.lines).toEqual([]);
    expect(text.errs).toEqual([
      'error: [trajectory-malformed] trajectory.actions must be an array (got null)',
    ]);
  });

  it('exits 2 with the code preserved when the major is unsupported', async () => {
    const dir = tmpRoot();
    const path = join(dir, 'future.json');
    writeFileSync(
      path,
      JSON.stringify({ ...fixtureTrajectory(), schema_version: '2.0' }),
    );
    const o = out();
    const exit = (
      await runReplayCommand({ trajectory: path, json: true }, deps(o))
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('unknown-major');
  });
});

describe('replay deterministic (different-model; Deterministic)', () => {
  function detArgs(dir: string): {
    traj: string;
    lock: string;
    base: ReplayCommandOptions;
  } {
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    return { traj, lock, base: { trajectory: traj, tier: 'deterministic' } };
  }

  it('refuses without pins (exit 2, runner never called, tier published)', async () => {
    const dir = tmpRoot();
    const { base } = detArgs(dir);
    for (const options of [
      base,
      { ...base, model: 'acme/m1' },
      { ...base, lockfile: join(dir, 'pins.json') },
    ]) {
      const o = out();
      let called = false;
      const exit = (
        await runReplayCommand(
          { ...options, json: true },
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
      expect(envelope.tier).toBe('deterministic');
      expect(envelope.error.code).toBe('deterministic-needs-pins');
    }
  });

  it('refuses a model pin outside provider/id form', async () => {
    const dir = tmpRoot();
    const { traj, lock } = detArgs(dir);
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'm1',
          lockfile: lock,
        },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/^error: \[invalid-model-pin\] /);
  });

  it('exits 5 when the lockfile is unreadable', async () => {
    const dir = tmpRoot();
    const { traj } = detArgs(dir);
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: join(dir, 'missing.json'),
          json: true,
        },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(5);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('lockfile-unreadable');
  });

  it('re-executes with pins: exit 0, tier deterministic in text and --json', async () => {
    const dir = tmpRoot();
    const { traj, lock, base } = detArgs(dir);
    const seen: unknown[] = [];
    const o = out();
    const exit = (
      await runReplayCommand(
        { ...base, model: 'acme/m1', lockfile: lock, json: true },
        {
          out: o.write,
          err: o.err,
          run: async (request) => {
            seen.push(request);
            return { terminus: 'completed', summary: 'replayed ok' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      tier: 'deterministic',
      model: 'acme/m1',
      trajectory: traj,
    });
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      tier: string;
      invocation: string;
      result: { summary: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.tier).toBe('deterministic');
    expect(envelope.invocation).toBe('different-model');
    expect(envelope.result.summary).toBe('replayed ok');
  });

  it('maps runner termini to exit codes 1/5/6', async () => {
    const dir = tmpRoot();
    const { traj, lock } = detArgs(dir);
    const cases = [
      { terminus: 'failed', code: 1 },
      { terminus: 'workspace_unavailable', code: 5 },
      { terminus: 'provider_probe_failed', code: 6 },
    ] as const;
    for (const { terminus, code } of cases) {
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
          {
            out: o.write,
            err: o.err,
            run: async () => ({ terminus, summary: terminus }),
          },
        )
      ).exitCode;
      expect(exit).toBe(code);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        exitCode: number;
        tier: string;
      };
      expect(envelope.exitCode).toBe(code);
      expect(envelope.tier).toBe('deterministic');
    }
  });

  it('fail-closes to exit 2 on a contract-violating runner terminus (never 3/4/undefined)', async () => {
    const dir = tmpRoot();
    const { traj, lock } = detArgs(dir);
    const termini = [
      'turn_limit',
      'approval_denied',
      'bogus-terminus',
      undefined,
    ];
    for (const terminus of termini) {
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
          {
            out: o.write,
            err: o.err,
            run: async () => ({
              terminus: terminus as unknown as 'completed',
              summary: String(terminus),
            }),
          },
        )
      ).exitCode;
      expect(exit).toBe(2);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        ok: boolean;
        exitCode: number;
        tier: string;
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(2);
      expect(envelope.tier).toBe('deterministic');
    }
  });

  it('is byte-identical across runs with the same pins', async () => {
    const dir = tmpRoot();
    const { traj, lock } = detArgs(dir);
    const run = async (): Promise<ReplayRunResult> => ({
      terminus: 'completed',
      summary: 'replayed ok',
    });
    const first = out();
    await runReplayCommand(
      {
        trajectory: traj,
        tier: 'deterministic',
        model: 'acme/m1',
        lockfile: lock,
        json: true,
      },
      { out: first.write, err: first.err, run },
    );
    const second = out();
    await runReplayCommand(
      {
        trajectory: traj,
        tier: 'deterministic',
        model: 'acme/m1',
        lockfile: lock,
        json: true,
      },
      { out: second.write, err: second.err, run },
    );
    expect(second.lines.join('\n')).toBe(first.lines.join('\n'));
  });
});

describe('replay pins: the lockfile and role config are enforced', () => {
  function digest(text: string): string {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  }

  function writePin(dir: string, name: string, extra: object): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        models: { 'acme/m1': { digest: 'sha256:abc' } },
        ...extra,
      }),
    );
    return path;
  }

  it('refuses a model the lockfile does not pin (exit 2, named)', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    const o = out();
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'other/m9',
          lockfile: lock,
          json: true,
        },
        deps(o),
      )
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe('lockfile-mismatch');
    expect(envelope.error.message).toMatch(
      /does not pin model "other\/m9" — refusing a deterministic replay at an unpinned model/,
    );
  });

  it('accepts the provider-keyed pin form (provider -> [ids])', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const lock = join(dir, 'pins.json');
    writeFileSync(lock, JSON.stringify({ models: { acme: ['m1'] } }));
    let called = false;
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: lock,
        },
        {
          ...deps(out()),
          run: async () => {
            called = true;
            return { terminus: 'completed', summary: 'ok' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(called).toBe(true);
  });

  it('refuses a lockfile whose prompt/tools pins do not match the trajectory', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    for (const [key, bad] of [
      ['prompt', { digest: digest('another prompt') }],
      ['tools', { digest: digest('read') }],
    ] as const) {
      const lock = writePin(dir, `${key}.json`, { [key]: bad });
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
      expect(exit, key).toBe(2);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        error: { code: string; message: string };
      };
      expect(envelope.error.code, key).toBe('lockfile-mismatch');
      expect(envelope.error.message, key).toMatch(
        new RegExp(`${key} pin sha256:.* does not match the recorded ${key}`),
      );
    }
  });

  it('accepts matching prompt/tools pins and re-executes', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writePin(dir, 'match.json', {
      prompt: { digest: digest(fixtureTrajectory().task.objective) },
      tools: { digest: digest('edit\nread') },
    });
    let called = false;
    const exit = (
      await runReplayCommand(
        {
          trajectory: traj,
          tier: 'deterministic',
          model: 'acme/m1',
          lockfile: lock,
        },
        {
          ...deps(out()),
          run: async () => {
            called = true;
            return { terminus: 'completed', summary: 'ok' };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(called).toBe(true);
  });

  it('refuses a malformed digest pin (exit 2, lockfile-invalid)', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writePin(dir, 'bad.json', { prompt: 'sha256:abc' });
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
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe('lockfile-invalid');
    expect(envelope.error.message).toMatch(/prompt pin must be an object/);
  });

  it('refuses a role config that is not the JSON pin form (exit 2, named)', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const cases: Array<[string, RegExp]> = [
      [
        'not json at all',
        /is not valid JSON — live replay needs \{"role": "<name>"\}/,
      ],
      [JSON.stringify({ tools: ['read'] }), /non-empty "role" name/],
      [JSON.stringify({ role: '  ' }), /non-empty "role" name/],
    ];
    for (const [index, [body, message]] of cases.entries()) {
      const role = join(dir, `role-${index}.json`);
      writeFileSync(role, body);
      const o = out();
      const exit = (
        await runReplayCommand(
          { trajectory: traj, tier: 'live', roleConfig: role, json: true },
          deps(o),
        )
      ).exitCode;
      expect(exit, body).toBe(2);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        error: { code: string; message: string };
      };
      expect(envelope.error.code, body).toBe('role-config-invalid');
      expect(envelope.error.message, body).toMatch(message);
    }
  });
});

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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const wt = tmpRoot('replay-wt-');
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
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
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    const wt = tmpRoot('replay-wt-');
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
    const dir = tmpRoot();
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
