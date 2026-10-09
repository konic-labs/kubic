// `kubic tui` writes a trajectory per settled turn: the
// same record `kubic run` writes, at <sessions-root>/<id>/trajectory.json,
// holding the session's latest settled turn. Real booted TUI lane, faux
// models only: zero network; temp sessions root and workspace.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
} from '@kubic/trajectory/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootTuiLane } from './tui/boot.js';
import { TuiTurnRunner } from './tui/turn-runner.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // One response per request, stamped when the request runs: the reader
  // filters a run's evidence by its messages' timestamps, so a fixture built
  // at boot would look older than the run it answers (real providers stamp
  // at generation time).
  faux.setResponses(
    texts.map((text) => async () => fauxAssistantMessage(text)),
  );
  return models;
}

// The runner's view seams, inert: this test observes the file, not the UI.
const app = {
  applyLaneEntries: () => {},
  applyPresentation: () => {},
  presentationSeed: () => ({
    sessionId: 'sess-1',
    model: 'faux/faux-1',
    approvalsSkipped: false,
  }),
  setUsage: () => {},
} as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];

beforeEach(() => {});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('kubic tui writes a trajectory per settled turn', () => {
  it('each settled turn writes <root>/<id>/trajectory.json for that turn', async () => {
    const root = tmp('tui-traj-root-');
    const ws = tmp('tui-traj-ws-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: root,
      models: fauxModels(['first answer', 'second answer']),
      env: new NodeExecutionEnv(ws),
    });
    try {
      const loop = boot.loop;
      expect(loop).toBeDefined();
      const runner = new TuiTurnRunner(app, loop as never, boot.model);
      const path = join(root, boot.sessionId, 'trajectory.json');
      const read = (): TrajectoryExport =>
        parseTrajectoryExportJSON(readFileSync(path, 'utf8'));

      expect((await runner.run('hello')).status).toBe('completed');
      const first = read();
      expect(first.prompt.text).toBe('hello');
      expect(first.result).toMatchObject({
        status: 'completed',
        failureCategory: null,
        summary: 'first answer',
      });
      expect(first.provenance).toMatchObject({
        sessionId: boot.sessionId,
        pid: process.pid,
        worktree: ws,
        model: boot.model,
      });
      expect(first.usage.requests).toBe(1);

      expect((await runner.run('again')).status).toBe('completed');
      const second = read();
      expect(second.prompt.text).toBe('again');
      expect(second.result.summary).toBe('second answer');
      // Only the latest turn's requests: the first turn is not re-counted.
      expect(second.usage.requests).toBe(1);
    } finally {
      await boot.close?.();
    }
  });
});
