import { describe, expect, it } from 'vitest';
import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import { computeSignals } from './signals.js';

function trajectory(
  overrides: Partial<TrajectoryExport> = {},
): TrajectoryExport {
  return {
    schema_version: '1.0',
    task: { taskId: 'task-1', objective: 'fix', role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: 'w-1' },
    model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: 'fix', constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [],
    observations: [],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      generation: 3,
      worktree: '/wt/agent-1',
      model: 'acme/m1',
    },
    environment: { capturedFrom: 'used', cwd: '/wt/agent-1', env: {} },
    worktree: { path: '/wt/agent-1', baseRevision: 'abc', branch: null },
    diff: { filesChanged: [], files: [] },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:01:00.000Z',
      durationMs: 60000,
    },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      requests: 2,
      costUsd: 0.02,
      byModel: {},
    },
    result: {
      status: 'completed',
      summary: 'done',
      failureCategory: null,
      error: null,
    },
    eval: { suite: null, caseId: null, labels: {} },
    ...overrides,
  };
}

describe('computeSignals (issue #53)', () => {
  it('derives tokens/cost/latency/tool/escalation counts from the trajectory', () => {
    const signals = computeSignals(
      trajectory({
        actions: [
          { seq: 1, tool: 'exec', args: null },
          { seq: 2, tool: 'exec', args: null },
          { seq: 3, tool: 'read', args: null },
        ],
        model: {
          provider: 'acme',
          model: 'm1',
          thinking: 'high',
          escalations: [{ reason: 'risk', at: '2026-09-23T10:00:30.000Z' }],
        },
      }),
    );
    expect(signals.tokens).toBe(150);
    expect(signals.costUsd).toBe(0.02);
    expect(signals.latencyMs).toBe(60000);
    expect(signals.toolCalls).toBe(3);
    expect(signals.toolCounts).toEqual({ exec: 2, read: 1 });
    expect(signals.escalations).toBe(1);
    expect(signals.completion).toBe(true);
  });

  it('marks a failed run as not completed with regression flagged', () => {
    const signals = computeSignals(
      trajectory({
        result: {
          status: 'failed',
          summary: 'broke',
          failureCategory: 'tool_failed',
          error: { kind: 'tool', message: 'exit 1' },
        },
      }),
    );
    expect(signals.completion).toBe(false);
    expect(signals.regressionFree).toBe(false);
    expect(signals.quality).toBe(0);
  });

  it('gates quality and regression-freedom on red signals, not completion alone', () => {
    const red = computeSignals(
      trajectory({
        eval: {
          suite: 'swe-bench-mini',
          caseId: 'case-1',
          labels: { 'signal:tests': 'fail' },
        },
      }),
    );
    expect(red.completion).toBe(true);
    expect(red.quality).toBe(0);
    expect(red.regressionFree).toBe(false);
  });

  it('reads tests/build/lint/typecheck signal labels, unknown by default', () => {
    const base = computeSignals(trajectory());
    expect([base.tests, base.build, base.lint, base.typecheck]).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    const labelled = computeSignals(
      trajectory({
        eval: {
          suite: 'swe-bench-mini',
          caseId: 'case-1',
          labels: { 'signal:tests': 'pass', 'signal:build': 'fail' },
        },
      }),
    );
    expect(labelled.tests).toBe('pass');
    expect(labelled.build).toBe('fail');
  });
});
