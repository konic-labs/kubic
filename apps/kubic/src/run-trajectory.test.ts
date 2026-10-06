// `--session <id>` resolves to a run's §46 trajectory (issue #383): export
// and replay read <sessions-root>/<id>/trajectory.json, so the printed ref
// and the session id are both ways back to the record. Faux provider only;
// temp sessions root and workspace.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runExportCommand } from '../../../packages/eval/src/export-cli.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runReplayCommand } from '../../../packages/host/src/replay/replay.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import { runHeadlessPrompt } from './headless-run.js';
import {
  persistRunTrajectory,
  resolveSessionTrajectory,
} from './run-trajectory.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
  vi.stubEnv('KUBIC_WORKER_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('persistRunTrajectory (issue #383)', () => {
  function persist(
    processEnv: NodeJS.ProcessEnv,
    extra: Partial<Parameters<typeof persistRunTrajectory>[0]> = {},
  ) {
    const root = tmp('traj-persist-root-');
    const cwd = tmp('traj-persist-cwd-');
    const path = persistRunTrajectory({
      sessionsRoot: root,
      sessionId: 'sess-1',
      agentId: 'root',
      role: 'solo',
      prompt: 'hello',
      entries: [],
      cwd,
      skills: [],
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { terminus: 'completed', summary: 'ok' },
      processEnv,
      pid: 4242,
      ...extra,
    });
    expect(path).toBe(join(root, 'sess-1', 'trajectory.json'));
    return {
      cwd,
      exported: parseTrajectoryExportJSON(readFileSync(path, 'utf8')),
    };
  }

  it('reads the worker identity from KUBIC_WORKER_ID / KUBIC_WORKER_GENERATION', () => {
    const cases: [NodeJS.ProcessEnv, string | null, number][] = [
      [{}, null, 0],
      [{ KUBIC_WORKER_ID: '', KUBIC_WORKER_GENERATION: '3' }, null, 0],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: '3' }, 'w1', 3],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: '0' }, 'w1', 0],
      [{ KUBIC_WORKER_ID: 'w1' }, 'w1', 0],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: '' }, 'w1', 0],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: 'x' }, 'w1', 0],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: '-2' }, 'w1', 0],
      [{ KUBIC_WORKER_ID: 'w1', KUBIC_WORKER_GENERATION: '1.5' }, 'w1', 0],
    ];
    for (const [env, workerId, generation] of cases) {
      const { exported } = persist(env);
      expect(exported.identity.workerId, JSON.stringify(env)).toBe(workerId);
      expect(exported.provenance.generation, JSON.stringify(env)).toBe(
        generation,
      );
    }
  });

  it('records the injected pid, the thinking level, no-vcs outside git and no model as none/none', () => {
    const { cwd, exported } = persist({ PATH: '/bin' }, { thinking: 'high' });
    expect(exported.provenance.pid).toBe(4242);
    expect(exported.model.thinking).toBe('high');
    expect(exported.provenance.model).toBe('none/none');
    expect(exported.worktree).toEqual({
      path: cwd,
      baseRevision: 'no-vcs',
      branch: null,
    });
    // The used env comes from the given process env, allowlisted.
    expect(exported.environment.env).toEqual({ PATH: '/bin' });
    // No journal or ledger yet: empty, never a failed write.
    expect(exported.diff).toEqual({ filesChanged: [], files: [] });
    expect(exported.approvals).toEqual([]);
  });

  // Issue #285 (§71): a budgeted run carries its limits, measured usage
  // and breach; an unbounded run carries no block at all.
  it('records the §71 budget block when the run was budgeted', () => {
    const { exported } = persist(
      {},
      {
        budget: {
          limits: { maxToolCalls: 1 },
          usage: { tokens: 10, costUsd: 0.01 },
          exhausted: { limit: 'toolCalls', used: 2, max: 1 },
        },
      },
    );
    expect(exported.budget).toEqual({
      limits: { maxToolCalls: 1 },
      usage: { tokens: 10, costUsd: 0.01 },
      exhausted: { limit: 'toolCalls', used: 2, max: 1 },
    });
  });

  it('omits the §71 budget block when the run was unbounded', () => {
    const { exported } = persist({});
    expect(exported.budget).toBeUndefined();
  });

  it('carries the lane escalation record into model.escalations (issue #210)', () => {
    const { exported } = persist(
      {},
      {
        escalations: [
          {
            reason: '3 consecutive tool failures',
            at: new Date(1_500).toISOString(),
            fromModel: 'faux/echo',
            toModel: 'faux/big',
            thinking: null,
          },
        ],
      },
    );
    expect(exported.model.escalations).toHaveLength(1);
    expect(exported.model.escalations[0]?.toModel).toBe('faux/big');
  });

  it('records a selected model and defaults thinking to null', () => {
    const { exported } = persist(
      {},
      { model: { provider: 'faux', id: 'echo' } },
    );
    expect(exported.provenance.model).toBe('faux/echo');
    expect(exported.model.thinking).toBeNull();
  });

  it("names the manager's §67 task when the run was handed one (issue #191)", () => {
    const { exported } = persist(
      {},
      {
        role: 'implementer',
        prompt: 'composed prompt',
        task: {
          taskId: 'sess-1:alpha',
          objective: 'Plan step 1 of 1: ship it',
          role: 'implementer',
        },
      },
    );
    expect(exported.task).toEqual({
      taskId: 'sess-1:alpha',
      objective: 'Plan step 1 of 1: ship it',
      role: 'implementer',
    });
    // Without a task the identity stays the prompt-derived one.
    const bare = persist({}, { prompt: 'composed prompt' });
    expect(bare.exported.task.taskId).toMatch(/^prompt:/);
  });
});

describe('resolveSessionTrajectory (issue #383)', () => {
  it('passes options through untouched without --session', () => {
    expect(resolveSessionTrajectory({ trajectory: 't.json' }, '/root')).toEqual(
      {
        options: { trajectory: 't.json' },
      },
    );
    const jsonOnly: { json: boolean; session?: string; trajectory?: string } = {
      json: true,
    };
    expect(resolveSessionTrajectory(jsonOnly, '/root')).toEqual({
      options: { json: true },
    });
  });

  it('maps --session <id> to <root>/<id>/trajectory.json', () => {
    expect(
      resolveSessionTrajectory({ session: 'abc-1', json: true }, '/root'),
    ).toEqual({
      options: { trajectory: '/root/abc-1/trajectory.json', json: true },
    });
  });

  it('refuses --session together with --trajectory, and a path-unsafe id', () => {
    expect(
      resolveSessionTrajectory({ session: 'a', trajectory: 't.json' }, '/r'),
    ).toEqual({ error: 'use either --trajectory or --session, not both' });
    expect(resolveSessionTrajectory({ session: '../x' }, '/r')).toEqual({
      error: 'invalid --session id "../x" (use [A-Za-z0-9_-])',
    });
  });

  it('export and replay read a run-produced trajectory by session id', async () => {
    const root = tmp('traj-session-root-');
    const ws = tmp('traj-session-ws-');
    const run = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: root,
        env: new NodeExecutionEnv(ws),
        modelsCwd: ws,
        warn: () => undefined,
      },
    );
    expect(run.terminus).toBe('completed');

    const exported = resolveSessionTrajectory(
      { session: run.sessionId, type: 'sft' },
      root,
    );
    if (!('options' in exported)) throw new Error(exported.error);
    const exportOut: string[] = [];
    const exportCode = await runExportCommand(exported.options, {
      readFile: (path) => readFileSync(path, 'utf8'),
      out: (line) => exportOut.push(line),
      err: () => undefined,
    });
    expect(exportCode).toBe(0);
    expect(JSON.parse(exportOut.join('\n'))).toMatchObject({ schema: 'sft/1' });

    const replayed = resolveSessionTrajectory(
      { session: run.sessionId, tier: 'recorded', json: true },
      root,
    );
    if (!('options' in replayed)) throw new Error(replayed.error);
    const replayOut: string[] = [];
    const replayCode = await runReplayCommand(replayed.options, {
      out: (line) => replayOut.push(line),
      err: () => undefined,
      run: async () => {
        throw new Error('recorded tier never re-executes');
      },
    });
    expect(replayCode).toBe(0);
    expect(JSON.parse(replayOut.join('\n'))).toMatchObject({
      ok: true,
      tier: 'recorded',
      trajectory: join(root, run.sessionId, 'trajectory.json'),
    });
  });
});
