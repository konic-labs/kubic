// Test-only fixture builder for RL export tests (issue #54).
// Builds minimal valid TrajectoryExport records (schema major 1, §46)
// so exporter tests exercise the real trajectory contract, faux-only.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';

export interface FixtureOverrides {
  pid?: number | null;
  generation?: number;
  worktree?: string;
  model?: string;
  baseRevision?: string;
  status?: TrajectoryExport['result']['status'];
  failureCategory?: TrajectoryExport['result']['failureCategory'];
  evalLabels?: Record<string, string>;
  transfer?: TrajectoryExport['transfer'];
  promptText?: string;
  summary?: string;
}

export function makeExport(overrides: FixtureOverrides = {}): TrajectoryExport {
  const worktree = overrides.worktree ?? '/wt/agent-1';
  return {
    schema_version: '1.0',
    task: { taskId: 'task-1', objective: 'fix the widget', role: 'implementer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
    model: {
      provider: 'faux',
      model: overrides.model ?? 'acme/m1',
      thinking: null,
      escalations: [],
    },
    prompt: { text: overrides.promptText ?? 'fix the widget', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: overrides.transfer ?? {
      taskId: 'task-1',
      worktree,
      grantRef: 'solo:exec',
    },
    actions: [],
    observations: [],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: overrides.pid ?? null,
      generation: overrides.generation ?? 3,
      worktree,
      model: overrides.model ?? 'acme/m1',
    },
    environment: { capturedFrom: 'used', cwd: worktree, env: {} },
    worktree: {
      path: worktree,
      baseRevision: overrides.baseRevision ?? 'abc123',
      branch: null,
    },
    diff: { filesChanged: [], files: [] },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T00:00:00.000Z',
      endedAt: '2026-09-23T00:01:00.000Z',
      durationMs: 60000,
    },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0.02,
      byModel: {},
    },
    result: {
      status: overrides.status ?? 'completed',
      summary: overrides.summary ?? 'done',
      failureCategory: overrides.failureCategory ?? null,
      error: null,
    },
    eval: { suite: null, caseId: null, labels: overrides.evalLabels ?? {} },
  };
}
