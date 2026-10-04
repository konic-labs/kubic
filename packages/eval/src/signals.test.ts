import { describe, expect, it } from 'vitest';
import type { TrajectoryExport } from '../../trajectory/src/schema.js';
import { computeSignals, gatesPass, patchQuality } from './signals.js';

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

function labelled(
  labels: Record<string, string>,
  status: TrajectoryExport['result']['status'] = 'completed',
): TrajectoryExport {
  return trajectory({
    eval: { suite: null, caseId: null, labels },
    ...(status === 'completed'
      ? {}
      : {
          result: {
            status,
            summary: 'x',
            failureCategory: 'model_failed',
            error: { kind: 'model', message: 'x' },
          },
        }),
  });
}

describe('regression and graded patch quality (issue #267)', () => {
  it('regressionFree is false when a gate that passed at base fails now', () => {
    const signals = computeSignals(
      labelled({ 'signal:tests': 'fail', 'signal:regression': 'fail' }),
    );
    expect(signals.regressionFree).toBe(false);
  });

  it('a gate already red at base is not a regression', () => {
    const signals = computeSignals(
      labelled({ 'signal:tests': 'fail', 'signal:regression': 'pass' }),
    );
    expect(signals.regressionFree).toBe(true);
    // Still not a success: the red gate vetoes it.
    expect(gatesPass(signals)).toBe(false);
  });

  it('a detected regression is never excused by a green current run', () => {
    const signals = computeSignals(
      labelled({ 'signal:tests': 'pass', 'signal:regression': 'fail' }),
    );
    expect(signals.regressionFree).toBe(false);
  });

  it('without a regression label, regression-freedom falls back to completion and no red gate', () => {
    expect(computeSignals(labelled({})).regressionFree).toBe(true);
    expect(
      computeSignals(labelled({ 'signal:regression': 'maybe' })).regressionFree,
    ).toBe(true);
    expect(
      computeSignals(labelled({ 'signal:lint': 'fail' })).regressionFree,
    ).toBe(false);
    expect(computeSignals(labelled({}, 'failed')).regressionFree).toBe(false);
  });

  it('grades quality as the fraction of known gates passing, 0 when not completed', () => {
    expect(computeSignals(labelled({})).quality).toBe(1);
    expect(
      computeSignals(
        labelled({
          'signal:tests': 'pass',
          'signal:build': 'pass',
          'signal:lint': 'fail',
          'signal:typecheck': 'pass',
        }),
      ).quality,
    ).toBe(0.75);
    expect(
      computeSignals(
        labelled({ 'signal:tests': 'pass', 'signal:lint': 'fail' }),
      ).quality,
    ).toBe(0.5);
    expect(
      computeSignals(labelled({ 'signal:tests': 'pass' }, 'failed')).quality,
    ).toBe(0);
  });

  it('halves quality when a regression was detected', () => {
    expect(
      computeSignals(
        labelled({
          'signal:tests': 'pass',
          'signal:lint': 'fail',
          'signal:regression': 'fail',
        }),
      ).quality,
    ).toBe(0.25);
    expect(
      computeSignals(labelled({ 'signal:regression': 'fail' })).quality,
    ).toBe(0.5);
  });

  it('patchQuality grades directly: unknown gates abstain, no gates is 1', () => {
    expect(patchQuality(false, ['pass', 'pass'], 'unknown')).toBe(0);
    expect(patchQuality(true, ['unknown', 'unknown'], 'unknown')).toBe(1);
    expect(patchQuality(true, ['pass', 'fail', 'unknown'], 'unknown')).toBe(
      0.5,
    );
    expect(patchQuality(true, ['pass', 'pass'], 'fail')).toBe(0.5);
  });
});

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

describe('gatesPass exact veto (issue #70)', () => {
  it('passes when every gate is pass or unknown', () => {
    expect(
      gatesPass({
        tests: 'pass',
        build: 'pass',
        lint: 'pass',
        typecheck: 'pass',
      }),
    ).toBe(true);
    expect(
      gatesPass({
        tests: 'unknown',
        build: 'unknown',
        lint: 'unknown',
        typecheck: 'unknown',
      }),
    ).toBe(true);
  });

  it('vetoes on exactly one red gate — each gate alone (issue #70)', () => {
    const gates = ['tests', 'build', 'lint', 'typecheck'] as const;
    for (const red of gates) {
      const signals: Record<(typeof gates)[number], 'pass' | 'fail'> = {
        tests: 'pass',
        build: 'pass',
        lint: 'pass',
        typecheck: 'pass',
      };
      signals[red] = 'fail';
      expect(gatesPass(signals)).toBe(false);
    }
  });

  it('treats non pass/fail label values as unknown, never as pass (issue #70)', () => {
    const odd = computeSignals(
      trajectory({
        eval: {
          suite: 'swe-bench-mini',
          caseId: 'case-1',
          labels: { 'signal:tests': 'PASS', 'signal:build': '' },
        },
      }),
    );
    expect(odd.tests).toBe('unknown');
    expect(odd.build).toBe('unknown');
    expect(
      gatesPass({
        tests: odd.tests,
        build: odd.build,
        lint: odd.lint,
        typecheck: odd.typecheck,
      }),
    ).toBe(true);
  });

  it('derives exact counts from the trajectory (issue #70)', () => {
    const signals = computeSignals(trajectory());
    expect(signals.tokens).toBe(150);
    expect(signals.costUsd).toBe(0.02);
    expect(signals.latencyMs).toBe(60000);
    expect(signals.toolCalls).toBe(0);
    expect(signals.toolCounts).toEqual({});
    expect(signals.escalations).toBe(0);
    expect(signals.quality).toBe(1);
    expect(signals.regressionFree).toBe(true);
  });
});
