// `kubic replay` at declared determinism tiers (issue #52; §47, §47.1,
// §72, §78). Faux-only: the re-execution runner is injected (zero
// network); trajectory fixtures are built with the versioned #51
// exporter so tests always run against the current stable contract.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTrajectoryExport } from '../../../trajectory/src/export.js';
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import {
  runReplayCommand,
  type ReplayCommandDeps,
  type ReplayRunResult,
} from './replay.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'replay-'));
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
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
      worktree: '/repo/.kubic/wt/agent-1',
      model: 'acme/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo/.kubic/wt/agent-1',
      env: {},
    },
    worktree: {
      path: '/repo/.kubic/wt/agent-1',
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

function deps(
  o: { lines: string[]; write: (line: string) => void },
  run?: ReplayCommandDeps['run'],
): ReplayCommandDeps {
  return {
    out: o.write,
    run:
      run ??
      (async (): Promise<ReplayRunResult> => {
        throw new Error('runner must not be called');
      }),
  };
}

describe('replay recorded exact (§47 exact; §47.1 Recorded)', () => {
  it('replays a versioned trajectory log-only: exit 0, tier printed, runner never called', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    let called = false;
    const exit = await runReplayCommand([path], {
      out: o.write,
      run: async () => {
        called = true;
        return { terminus: 'completed', summary: 'must not run' };
      },
    });
    expect(exit).toBe(0);
    expect(called).toBe(false);
    const text = o.lines.join('\n');
    expect(text).toMatch(/tier: recorded/);
    expect(text).toMatch(/acme\/m1/);
    expect(text).toMatch(/result: completed/);
  });

  it('publishes the tier in the --json envelope (§72)', async () => {
    const dir = tmpRoot();
    const path = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = await runReplayCommand([path, '--json'], deps(o));
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
    const exit = await runReplayCommand(
      [join(tmpRoot(), 'nope.json'), '--json'],
      deps(o),
    );
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
    const exit = await runReplayCommand([path, '--json'], deps(o));
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('trajectory-malformed');
  });

  it('exits 2 with the code preserved when the major is unsupported', async () => {
    const dir = tmpRoot();
    const path = join(dir, 'future.json');
    writeFileSync(
      path,
      JSON.stringify({ ...fixtureTrajectory(), schema_version: '2.0' }),
    );
    const o = out();
    const exit = await runReplayCommand([path, '--json'], deps(o));
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('unknown-major');
  });
});

describe('replay deterministic (§47 different-model; §47.1 Deterministic)', () => {
  function detArgs(dir: string): {
    traj: string;
    lock: string;
    base: string[];
  } {
    const traj = writeTrajectory(dir, 't.json');
    const lock = writeLockfile(dir, 'pins.json');
    return { traj, lock, base: [traj, '--tier', 'deterministic'] };
  }

  it('refuses without pins (exit 2, runner never called, tier published)', async () => {
    const dir = tmpRoot();
    const { base } = detArgs(dir);
    for (const args of [
      [...base],
      [...base, '--model', 'acme/m1'],
      [...base, '--lockfile', join(dir, 'pins.json')],
    ]) {
      const o = out();
      let called = false;
      const exit = await runReplayCommand([...args, '--json'], {
        out: o.write,
        run: async () => {
          called = true;
          return { terminus: 'completed', summary: 'must not run' };
        },
      });
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
    const exit = await runReplayCommand(
      [traj, '--tier', 'deterministic', '--model', 'm1', '--lockfile', lock],
      deps(o),
    );
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/invalid-model-pin/);
  });

  it('exits 5 when the lockfile is unreadable', async () => {
    const dir = tmpRoot();
    const { traj } = detArgs(dir);
    const o = out();
    const exit = await runReplayCommand(
      [
        traj,
        '--tier',
        'deterministic',
        '--model',
        'acme/m1',
        '--lockfile',
        join(dir, 'missing.json'),
        '--json',
      ],
      deps(o),
    );
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
    const exit = await runReplayCommand(
      [...base, '--model', 'acme/m1', '--lockfile', lock, '--json'],
      {
        out: o.write,
        run: async (request) => {
          seen.push(request);
          return { terminus: 'completed', summary: 'replayed ok' };
        },
      },
    );
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

  it('maps runner termini to §78 codes 1/5/6', async () => {
    const dir = tmpRoot();
    const { traj, lock } = detArgs(dir);
    const cases = [
      { terminus: 'failed', code: 1 },
      { terminus: 'workspace_unavailable', code: 5 },
      { terminus: 'provider_probe_failed', code: 6 },
    ] as const;
    for (const { terminus, code } of cases) {
      const o = out();
      const exit = await runReplayCommand(
        [
          traj,
          '--tier',
          'deterministic',
          '--model',
          'acme/m1',
          '--lockfile',
          lock,
          '--json',
        ],
        {
          out: o.write,
          run: async () => ({ terminus, summary: terminus }),
        },
      );
      expect(exit).toBe(code);
      const envelope = JSON.parse(o.lines.join('\n')) as {
        exitCode: number;
        tier: string;
      };
      expect(envelope.exitCode).toBe(code);
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
      [traj, '--tier', 'deterministic', '--model', 'acme/m1', '--lockfile', lock, '--json'],
      { out: first.write, run },
    );
    const second = out();
    await runReplayCommand(
      [traj, '--tier', 'deterministic', '--model', 'acme/m1', '--lockfile', lock, '--json'],
      { out: second.write, run },
    );
    expect(second.lines.join('\n')).toBe(first.lines.join('\n'));
  });
});

describe('replay live (§47.1 Live)', () => {
  function writeRoleConfig(dir: string, name: string, body?: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      body ?? '---\nrole: implementer\ntools: [read, edit]\n---\n\nDo the task.\n',
    );
    return path;
  }

  it('refuses without a pinned role config (exit 2, runner never called)', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const o = out();
    let called = false;
    const exit = await runReplayCommand([traj, '--tier', 'live', '--json'], {
      out: o.write,
      run: async () => {
        called = true;
        return { terminus: 'completed', summary: 'must not run' };
      },
    });
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
    for (const extra of [
      ['--model', 'acme/m1'],
      ['--lockfile', lock],
    ]) {
      const o = out();
      const exit = await runReplayCommand(
        [traj, '--tier', 'live', '--role-config', role, ...extra],
        deps(o),
      );
      expect(exit).toBe(2);
      expect(o.lines.join('\n')).toMatch(/unexpected-flag-for-tier/);
    }
  });

  it('exits 5 when the role config is unreadable', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const o = out();
    const exit = await runReplayCommand(
      [traj, '--tier', 'live', '--role-config', join(dir, 'missing.md'), '--json'],
      deps(o),
    );
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
    const exit = await runReplayCommand(
      [traj, '--tier', 'live', '--role-config', role],
      deps(o),
    );
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/role-config-invalid/);
  });

  it('re-executes live: tier live, invocation exact, runner gets role config', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const seen: unknown[] = [];
    const o = out();
    const exit = await runReplayCommand(
      [traj, '--tier', 'live', '--role-config', role, '--json'],
      {
        out: o.write,
        run: async (request) => {
          seen.push(request);
          return { terminus: 'completed', summary: 'live ok' };
        },
      },
    );
    expect(exit).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      tier: 'live',
      roleConfig: role,
      model: 'acme/m1',
    });
    const envelope = JSON.parse(o.lines.join('\n')) as {
      tier: string;
      invocation: string;
    };
    expect(envelope.tier).toBe('live');
    expect(envelope.invocation).toBe('exact');
  });

  it('live with --worktree override is a different-worktree invocation (experimental)', async () => {
    const dir = tmpRoot();
    const traj = writeTrajectory(dir, 't.json');
    const role = writeRoleConfig(dir, 'role.md');
    const wt = mkdtempSync(join(tmpdir(), 'replay-wt-'));
    const seen: unknown[] = [];
    const o = out();
    const exit = await runReplayCommand(
      [traj, '--tier', 'live', '--role-config', role, '--worktree', wt, '--json'],
      {
        out: o.write,
        run: async (request) => {
          seen.push(request);
          return { terminus: 'completed', summary: 'live ok' };
        },
      },
    );
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
