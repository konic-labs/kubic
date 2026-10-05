// Prod `kubic run -p` writes a §46 trajectory (issue #383): the settled run
// persists <sessions-root>/<id>/trajectory.json, the exporter's fail-closed
// rules hold on the live path, and the printed ref names that file. Faux
// provider only (KUBIC_PROVIDER=faux, the shipped testing provider): zero
// network; temp sessions root and workspace, never the real HOME.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NodeExecutionEnv,
  toolSpawnEnv,
} from '../../../packages/exec/src/env.js';
import {
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
} from '../../../packages/host/src/faux-provider.js';
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import { trajectoryResultFor } from '../../../packages/host/src/trajectory/run-trajectory.js';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
} from '../../../packages/trajectory/src/schema.js';
import { runHeadlessPrompt } from './headless-run.js';

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
  vi.stubEnv('KUBIC_WORKER_GENERATION', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(
  prompt: string,
  options: Parameters<typeof runHeadlessPrompt>[1] = {},
) {
  const root = tmp('traj-root-');
  const ws = tmp('traj-ws-');
  return {
    root,
    ws,
    result: runHeadlessPrompt(prompt, options, {
      sessionsRoot: root,
      env: new NodeExecutionEnv(ws),
      modelsCwd: ws,
      warn: () => undefined,
    }),
  };
}

function readTrajectory(path: string): TrajectoryExport {
  return parseTrajectoryExportJSON(readFileSync(path, 'utf8'));
}

describe('kubic run writes a §46 trajectory (issue #383)', () => {
  it('a completed faux run writes <root>/<id>/trajectory.json and the ref names it', async () => {
    const {
      root,
      ws,
      result: pending,
    } = run('faux:tool read {"path":"a.txt"}');
    const result = await pending;
    expect(result.terminus).toBe('completed');
    const path = join(root, result.sessionId, 'trajectory.json');
    expect(result.trajectoryRef).toBe(path);
    expect(existsSync(path)).toBe(true);
    const exported = readTrajectory(path);
    expect(exported.provenance).toMatchObject({
      sessionId: result.sessionId,
      agentId: 'root',
      pid: process.pid,
      generation: 0,
      worktree: ws,
      model: `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`,
    });
    expect(exported.identity.workerId).toBeNull();
    expect(exported.prompt.text).toBe('faux:tool read {"path":"a.txt"}');
    expect(exported.actions.map((action) => action.tool)).toEqual(['read']);
    expect(exported.observations).toHaveLength(1);
    expect(exported.usage.requests).toBe(2);
    expect(exported.result).toMatchObject({
      status: 'completed',
      failureCategory: null,
      summary: result.summary,
    });
  });

  it('records the used tool env: environment.env keys equal toolSpawnEnv() keys', async () => {
    vi.stubEnv('KUBIC_TEST_SECRET_TOKEN', 'do-not-record');
    const { result: pending } = run('hello');
    const result = await pending;
    const exported = readTrajectory(result.trajectoryRef);
    expect(Object.keys(exported.environment.env).sort()).toEqual(
      Object.keys(toolSpawnEnv()).sort(),
    );
    expect(exported.environment.capturedFrom).toBe('used');
    expect(readFileSync(result.trajectoryRef, 'utf8')).not.toContain(
      'do-not-record',
    );
  });

  it('a run that does not complete writes a trajectory with a non-null failure category', {
    timeout: 20_000,
  }, async () => {
    // A long tool call under a short wall-clock bound: the guard (or, when
    // the installed policy challenges the shell call, the approval gate)
    // ends the run — either way a non-completed terminus on the real lane.
    const { result: pending } = run('faux:tool bash {"command":"sleep 5"}', {
      timeoutMs: 300,
    });
    const result = await pending;
    expect(result.terminus).not.toBe('completed');
    const exported = readTrajectory(result.trajectoryRef);
    const expected = trajectoryResultFor({
      terminus: result.terminus,
      summary: result.summary,
    });
    expect(exported.result.status).toBe(expected.status);
    expect(exported.result.failureCategory).not.toBeNull();
    expect(exported.result.failureCategory).toBe(expected.failureCategory);
    expect(exported.result.error).toEqual({
      kind: result.terminus,
      message: result.summary,
    });
  });

  it('a run that fails before a model is selected still writes a fail-closed trajectory', async () => {
    const { result: pending } = run('hello', { role: 'no-such-role' });
    const result = await pending;
    expect(result.terminus).toBe('failed');
    const exported = readTrajectory(result.trajectoryRef);
    expect(exported.result.status).toBe('failed');
    expect(exported.result.failureCategory).toBe('process_crashed');
    expect(exported.provenance.model).toBe('none/none');
  });

  it('an orchestrator worker child records its worker id and generation', async () => {
    vi.stubEnv('KUBIC_WORKER_ID', 'agent-7');
    vi.stubEnv('KUBIC_WORKER_GENERATION', '3');
    // The child prints its readiness marker on stdout; keep it off the
    // test runner's output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { ws, result: pending } = run('hello');
    const result = await pending;
    const exported = readTrajectory(result.trajectoryRef);
    expect(exported.identity.workerId).toBe('agent-7');
    expect(exported.provenance.generation).toBe(3);
    expect(exported.provenance.worktree).toBe(ws);
  });

  it('`kubic run --json`: the envelope trajectory ref names the written file', async () => {
    const root = tmp('traj-root-');
    const ws = tmp('traj-ws-');
    const lines: string[] = [];
    const exit = await runRunCommand(
      { prompt: 'hello', json: true },
      {
        out: (line) => lines.push(line),
        run: (prompt, options) =>
          runHeadlessPrompt(prompt, options, {
            sessionsRoot: root,
            env: new NodeExecutionEnv(ws),
            modelsCwd: ws,
            warn: () => undefined,
          }),
      },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(lines.join('\n')) as {
      sessionId: string;
      trajectory: { ref: string };
    };
    expect(envelope.trajectory.ref).toBe(
      join(root, envelope.sessionId, 'trajectory.json'),
    );
    expect(() => readTrajectory(envelope.trajectory.ref)).not.toThrow();
  });
});
