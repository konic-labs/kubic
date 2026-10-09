// Prod replay re-execution runner: re-runs the recorded
// objective through the lane and maps the settled terminus into replay's
// Subset.

import { buildTrajectoryExport } from '@kubic/trajectory/export';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { describe, expect, it } from 'vitest';
import type { ReplayRunRequest } from './replay.js';
import { createProdReplayRun } from './run-prod.js';

function fixtureTrajectory(objective = 'Fix the widget'): TrajectoryExport {
  return buildTrajectoryExport({
    task: { taskId: 'task-1', objective, role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1' },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget' },
    resources: { skills: [] },
    actions: [],
    observations: [],
    state: { phase: 'done' },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
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

function request(): ReplayRunRequest {
  return {
    tier: 'deterministic',
    trajectory: 't.json',
    model: 'acme/m1',
    worktree: '/repo',
    lockfile: 'pins.json',
    roleConfig: null,
    role: null,
  };
}

describe('prod replay runner', () => {
  it('re-executes the recorded objective and hands the pins to the run seam', async () => {
    const seen: Array<{ prompt: string; model: string; request: unknown }> = [];
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory(),
      runPrompt: async (prompt, model, request) => {
        seen.push({ prompt, model, request });
        return { terminus: 'completed', summary: 'redone' };
      },
    });
    const pinned = request();
    const result = await run(pinned);
    expect(result).toEqual({ terminus: 'completed', summary: 'redone' });
    expect(seen).toEqual([
      { prompt: 'Fix the widget', model: 'acme/m1', request: pinned },
    ]);
  });

  it('passes failed/workspace_unavailable/provider_probe_failed through', async () => {
    for (const terminus of [
      'failed',
      'workspace_unavailable',
      'provider_probe_failed',
    ]) {
      const run = createProdReplayRun({
        loadTrajectory: () => fixtureTrajectory(),
        runPrompt: async () => ({ terminus, summary: `${terminus} detail` }),
      });
      const result = await run(request());
      expect(result.terminus).toBe(terminus);
      expect(result.summary).toBe(`${terminus} detail`);
    }
  });

  it('coarsens non-subset lane termini to failed with the summary preserved', async () => {
    for (const terminus of [
      'turn_limit',
      'approval_denied',
      'approval_timed_out',
      'usage',
    ]) {
      const run = createProdReplayRun({
        loadTrajectory: () => fixtureTrajectory(),
        runPrompt: async () => ({ terminus, summary: `${terminus} detail` }),
      });
      const result = await run(request());
      expect(result.terminus).toBe('failed');
      expect(result.summary).toMatch(/detail/);
    }
  });

  it('maps a throwing lane to failed instead of rejecting', async () => {
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory(),
      runPrompt: async () => {
        throw new Error('lane blew up');
      },
    });
    const result = await run(request());
    expect(result.terminus).toBe('failed');
    expect(result.summary).toMatch(/lane blew up/);
  });

  it('refuses an empty objective without calling the lane', async () => {
    let called = false;
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory('   '),
      runPrompt: async () => {
        called = true;
        return { terminus: 'completed', summary: 'must not run' };
      },
    });
    const result = await run(request());
    expect(called).toBe(false);
    expect(result.terminus).toBe('failed');
    expect(result.summary).toMatch(/objective/);
  });
});
