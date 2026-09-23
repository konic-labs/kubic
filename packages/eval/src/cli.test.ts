import { describe, expect, it } from 'vitest';
import { runBenchmarkCommand, runEvalCommand } from './cli.js';
import type { EvalSignals } from './signals.js';

function signals(): EvalSignals {
  return {
    tests: 'unknown',
    build: 'unknown',
    lint: 'unknown',
    typecheck: 'unknown',
    completion: true,
    quality: 1,
    regressionFree: true,
    tokens: 150,
    costUsd: 0.02,
    latencyMs: 60000,
    toolCalls: 3,
    toolCounts: { exec: 3 },
    escalations: 0,
  };
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

const deps = {
  runSuite: async () => ({
    success: true,
    signals: signals(),
    usageRows: [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
    ],
  }),
  ensureCleanWorktree: () => true,
};

describe('eval command (issue #53)', () => {
  it('scores --task and prints a record', async () => {
    const o = out();
    const exit = await runEvalCommand(
      [
        '--suite',
        'swe-bench-mini',
        '--task',
        'fix the widget',
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '3',
        '--tier',
        'standard',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(0);
    expect(o.lines.join('\n')).toMatch(/swe-bench-mini/);
  });

  it('emits a jq-able --json envelope', async () => {
    const o = out();
    const exit = await runEvalCommand(
      [
        '--suite',
        'swe-bench-mini',
        '--task',
        'fix',
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '3',
        '--tier',
        'standard',
        '--json',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      record: { suite: string; worktree: string; tier: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.record.suite).toBe('swe-bench-mini');
    expect(envelope.record.tier).toBe('standard');
  });

  it('exits 2 when worktree/generation/tier are missing', async () => {
    const o = out();
    const exit = await runEvalCommand(
      ['--suite', 'swe-bench-mini', '--task', 'fix', '--model', 'acme/m1'],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/worktree|generation|tier/i);
  });

  it('exits 2 on an invalid --workspace instead of coercing to inline', async () => {
    const o = out();
    const exit = await runEvalCommand(
      [
        '--suite',
        'swe-bench-mini',
        '--task',
        'fix',
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '3',
        '--tier',
        'standard',
        '--workspace',
        'worktreee',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/workspace/i);
  });

  it('scores --trajectory without running a suite', async () => {
    const o = out();
    let ran = false;
    const trajectory = JSON.stringify({
      schema_version: '1.0',
      task: { taskId: 't', objective: 'fix', role: 'writer' },
      identity: { sessionId: 's', agentId: 'a', workerId: 'w' },
      model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
      prompt: { text: 'fix', constraints: [] },
      resources: { skills: [], promptTemplates: [] },
      transfer: null,
      actions: [],
      observations: [],
      state: { phase: 'done', snapshot: null },
      provenance: {
        sessionId: 's',
        agentId: 'a',
        pid: null,
        generation: 3,
        worktree: '/wt/a',
        model: 'acme/m1',
      },
      environment: { capturedFrom: 'used', cwd: '/wt/a', env: {} },
      worktree: { path: '/wt/a', baseRevision: 'abc', branch: null },
      diff: { filesChanged: [], files: [] },
      approvals: [],
      timestamps: {
        startedAt: '2026-09-23T10:00:00.000Z',
        endedAt: '2026-09-23T10:01:00.000Z',
        durationMs: 1000,
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
      eval: { suite: null, caseId: null, labels: {} },
    });
    const exit = await runEvalCommand(
      [
        '--suite',
        'swe-bench-mini',
        '--trajectory',
        trajectory,
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '3',
        '--tier',
        'standard',
      ],
      {
        out: o.write,
        runSuite: async () => {
          ran = true;
          return { success: true, signals: signals() };
        },
      },
    );
    expect(exit).toBe(0);
    expect(ran).toBe(false);
  });
});

describe('benchmark command (issue #53)', () => {
  it('runs the full matrix: >=1 suite per category, stubs marked skipped', async () => {
    const o = out();
    const exit = await runBenchmarkCommand(
      [
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '3',
        '--tier',
        'standard',
        '--json',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      results: Array<{
        suite: string;
        category: string;
        stub: boolean;
        success: boolean;
      }>;
    };
    expect(envelope.ok).toBe(true);
    const categories = new Set(envelope.results.map((r) => r.category));
    for (const expected of [
      'swe',
      'repo-mod',
      'bugfix',
      'refactor',
      'testgen',
      'review',
      'terminal',
      'agentic',
    ]) {
      expect(categories.has(expected), `missing ${expected}`).toBe(true);
    }
    const stubs = envelope.results.filter((r) => r.stub);
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) {
      expect(stub.success).toBe(false);
    }
  });

  it('runs a single suite via --suite swe', async () => {
    const o = out();
    const exit = await runBenchmarkCommand(
      [
        '--suite',
        'swe-bench-mini',
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '1',
        '--tier',
        'smoke',
        '--workspace',
        'worktree',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(0);
    expect(o.lines.join('\n')).toMatch(/swe-bench-mini/);
  });

  it('reports a stub-only run as skipped (success:false) yet exits 0', async () => {
    const o = out();
    const exit = await runBenchmarkCommand(
      [
        '--suite',
        'terminal-live',
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '1',
        '--tier',
        'smoke',
        '--json',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      results: Array<{ stub: boolean; skipped: boolean; success: boolean }>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0]).toMatchObject({
      stub: true,
      skipped: true,
      success: false,
    });
  });

  it('exits 2 on an invalid --workspace', async () => {
    const o = out();
    const exit = await runBenchmarkCommand(
      [
        '--model',
        'acme/m1',
        '--worktree',
        '/wt/a',
        '--generation',
        '1',
        '--tier',
        'smoke',
        '--workspace',
        'worktreee',
      ],
      { ...deps, out: o.write },
    );
    expect(exit).toBe(2);
    expect(o.lines.join('\n')).toMatch(/workspace/i);
  });
});
