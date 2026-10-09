// Prod `kubic replay` re-execution runner: the composition
// root's model-pin gate. An unregistered provider/id must never reach the
// lane — it reports provider_probe_failed (exit 6) instead of silently
// re-executing at another model — and the relative trajectory path must
// resolve against the working directory. Faux provider only; the lane
// prompt runner is mocked so the test can prove it is NOT called for a
// refused pin, and the model catalog is assembled for real from the faux
// registry (no network, no credentials).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSIONS,
  type PermissionClasses,
} from '@kubic/agent/permissions';
import type { ReplayRunRequest, ReplayRuntimeDeps } from '@kubic/host/replay';
import { buildTrajectoryExport } from '@kubic/trajectory/export';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The lane entry the re-execution drives: mocked away so a refused pin is
// observable as "never booted" (and no real lane, journal or model is
// touched by a passing test).
const lane = vi.hoisted(() => ({ runHeadlessPrompt: vi.fn() }));
vi.mock('./run/command.js', () => ({
  runHeadlessPrompt: lane.runHeadlessPrompt,
}));

import { runProdReplay } from './replay-run.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fixtureTrajectory(objective = 'Fix the widget'): TrajectoryExport {
  return buildTrajectoryExport({
    task: { taskId: 'task-1', objective, role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1' },
    model: { provider: 'faux', model: 'echo', thinking: null, escalations: [] },
    prompt: { text: objective },
    resources: { skills: [] },
    actions: [],
    observations: [],
    state: { phase: 'done' },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      worktree: '/repo',
      model: 'faux/echo',
    },
    environment: { capturedFrom: 'used', cwd: '/repo', env: {} },
    worktree: { path: '/repo', baseRevision: 'abc123', branch: null },
    diff: { filesChanged: [], files: [] },
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
}

// A temp working directory holding `traj.json`, spied as process.cwd: the
// relative trajectory operand must resolve against it (the same bug class
// the export path fixed).
function cwdWithTrajectory(objective?: string): string {
  const dir = tempDir('replay-run-');
  writeFileSync(
    join(dir, 'traj.json'),
    JSON.stringify(fixtureTrajectory(objective)),
  );
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

function request(overrides: Partial<ReplayRunRequest> = {}): ReplayRunRequest {
  return {
    tier: 'deterministic',
    trajectory: 'traj.json',
    model: 'faux/echo',
    worktree: '/repo',
    lockfile: 'pins.json',
    roleConfig: null,
    role: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  lane.runHeadlessPrompt.mockReset();
  lane.runHeadlessPrompt.mockResolvedValue({
    terminus: 'completed',
    summary: 'redone',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prod replay re-execution runner', () => {
  it('refuses an unregistered provider before booting the lane', async () => {
    cwdWithTrajectory();
    const result = await runProdReplay(request({ model: 'ghost/echo' }));
    expect(result).toEqual({
      terminus: 'provider_probe_failed',
      summary: "unknown model 'echo' on provider 'ghost' (--model)",
    });
    expect(lane.runHeadlessPrompt).not.toHaveBeenCalled();
  });

  it('refuses an unknown model id on a known provider before booting the lane', async () => {
    cwdWithTrajectory();
    const result = await runProdReplay(request({ model: 'faux/nope' }));
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.summary).toBe(
      "unknown model 'nope' on provider 'faux' (--model)",
    );
    expect(lane.runHeadlessPrompt).not.toHaveBeenCalled();
  });

  it('maps a malformed pin (ModelSelectError) and never boots the lane', async () => {
    cwdWithTrajectory();
    const result = await runProdReplay(request({ model: 'faux' }));
    expect(result).toEqual({
      terminus: 'provider_probe_failed',
      summary: `--model must be 'provider/id' (got "faux")`,
    });
    expect(lane.runHeadlessPrompt).not.toHaveBeenCalled();
  });

  it('does not map a non-ModelSelectError from the run to provider_probe_failed', async () => {
    cwdWithTrajectory();
    lane.runHeadlessPrompt.mockRejectedValue(new Error('provider blew up'));
    const result = await runProdReplay(request());
    expect(result).toEqual({
      terminus: 'failed',
      summary: 'provider blew up',
    });
    expect(lane.runHeadlessPrompt).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative trajectory path against the working directory', async () => {
    cwdWithTrajectory('Fix the widget from <cwd>');
    const result = await runProdReplay(request({ trajectory: 'traj.json' }));
    expect(result).toEqual({ terminus: 'completed', summary: 'redone' });
    expect(lane.runHeadlessPrompt.mock.calls[0]?.[0]).toBe(
      'Fix the widget from <cwd>',
    );
  });

  it('threads the selected model and the runtime deps into the lane run', async () => {
    cwdWithTrajectory();
    const policyClasses: PermissionClasses = {
      ...DEFAULT_PERMISSIONS,
      shell: false,
    };
    const runtime: ReplayRuntimeDeps = {
      policySource: 'config',
      policyClasses,
    };
    await runProdReplay(request({ model: 'faux/echo' }), runtime);
    const [prompt, options, deps] = lane.runHeadlessPrompt.mock.calls[0] ?? [];
    expect(prompt).toBe('Fix the widget');
    expect(options).toEqual({});
    expect(deps).toMatchObject({
      model: { provider: 'faux', id: 'echo' },
      policySource: 'config',
      policyClasses,
    });
    expect(deps.models).toBeDefined();
  });

  it('defaults the runtime deps when none are given', async () => {
    cwdWithTrajectory();
    await runProdReplay(request());
    const deps = lane.runHeadlessPrompt.mock.calls[0]?.[2];
    expect(deps.policySource).toBe('default');
    expect(deps.policyClasses).toBeUndefined();
  });

  it('threads the runtime trustProject into catalog assembly', async () => {
    cwdWithTrajectory();
    const trustProject = vi.fn((_path: string) => false);
    await runProdReplay(request(), { policySource: 'config', trustProject });
    expect(trustProject).toHaveBeenCalledTimes(1);
    expect(trustProject.mock.calls[0]?.[0]).toBe(process.cwd());
  });

  it('roots the lane at the pinned worktree and boots the pinned role', async () => {
    cwdWithTrajectory();
    const worktree = tempDir('replay-worktree-');
    const roleConfig = join(worktree, 'role.json');
    writeFileSync(roleConfig, JSON.stringify({ role: 'reader' }));
    const layers = [{ layer: 'project' as const, roles: { reader: {} } }];
    const result = await runProdReplay(
      request({ tier: 'live', role: 'reader', roleConfig, worktree }),
      {
        policySource: 'config',
        agentId: 'alice',
        roles: { layers },
        reconcileOutOfScope: ['dist'],
      },
    );
    expect(result).toEqual({ terminus: 'completed', summary: 'redone' });
    const [prompt, options, deps] = lane.runHeadlessPrompt.mock.calls[0] ?? [];
    expect(prompt).toBe('Fix the widget');
    // The role pin is applied, not checked-then-ignored: the lane boots as
    // the named role, whose tools and prompt the role machinery installs.
    expect(options).toEqual({ role: 'reader' });
    // AC: --worktree gives lane env.cwd === dir; the role document and the
    // project models.json resolve in that same tree.
    expect(deps.env.cwd).toBe(worktree);
    expect(deps.roles).toEqual({ cwd: worktree, layers });
    expect(deps.agentId).toBe('alice');
    expect(deps.reconcileOutOfScope).toEqual(['dist']);
  });

  it('boots no role when the request carries none (deterministic tier)', async () => {
    cwdWithTrajectory();
    await runProdReplay(request());
    const options = lane.runHeadlessPrompt.mock.calls[0]?.[1];
    expect(options).toEqual({});
  });

  it('falls back to the working directory when the recorded worktree is absent', async () => {
    const cwd = cwdWithTrajectory();
    await runProdReplay(request({ worktree: join(cwd, 'does-not-exist') }));
    const deps = lane.runHeadlessPrompt.mock.calls[0]?.[2];
    expect(deps.env.cwd).toBe(cwd);
    expect(deps.roles.cwd).toBe(cwd);
  });
});
