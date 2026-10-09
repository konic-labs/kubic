// Prod `kubic run -p` writes a trajectory: the settled run
// persists <sessions-root>/<id>/trajectory.json, the exporter's fail-closed
// rules hold on the live path, and the printed ref names that file. Faux
// provider only (KUBIC_PROVIDER=faux, the shipped testing provider): zero
// network; temp sessions root and workspace, never the real HOME.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeExecutionEnv, toolSpawnEnv } from '@kubic/exec/env';
import { FAUX_MODEL_ID, FAUX_PROVIDER_ID } from '@kubic/host/models';
import { runRunCommand, trajectoryResultFor } from '@kubic/host/run';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
} from '@kubic/trajectory/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function run(
  prompt: string,
  options: Parameters<typeof runHeadlessPrompt>[1] = {},
) {
  const root = tempDir('traj-root-');
  const ws = tempDir('traj-ws-');
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

describe('kubic run writes a trajectory', () => {
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
      worktree: ws,
      model: `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`,
    });
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

  it('`kubic run --json`: the envelope trajectory ref names the written file', async () => {
    const root = tempDir('traj-root-');
    const ws = tempDir('traj-ws-');
    const lines: string[] = [];
    const exit = (
      await runRunCommand(
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
      )
    ).exitCode;
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
