// A recorded trajectory for the replay tests to replay, compare and pin.
import { buildTrajectoryExport } from '@kubic/trajectory/export';
import type { TrajectoryExport } from '@kubic/trajectory/schema';

export function fixtureTrajectory(
  overrides: Partial<TrajectoryExport> = {},
): TrajectoryExport {
  const base = buildTrajectoryExport({
    task: { taskId: 'task-1', objective: 'Fix the widget', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1' },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'Fix the widget' },
    resources: { skills: [] },
    actions: [
      { seq: 1, tool: 'read', args: { path: 'a.ts' } },
      { seq: 2, tool: 'edit', args: { path: 'a.ts' } },
    ],
    observations: [{ seq: 1, actionSeq: 1, output: 'hello' }],
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
