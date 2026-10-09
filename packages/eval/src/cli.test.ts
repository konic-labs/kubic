import { EXIT_FAILED } from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
import { runBenchmarkCommand, runEvalCommand } from './cli.js';
import type { EvalSignals } from './signals.js';
import { makeExport } from './test-support/fixtures.js';

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

// stdout (`lines`) and stderr (`errs`) captured separately.
function out(): {
  lines: string[];
  errs: string[];
  write: (line: string) => void;
  err: (line: string) => void;
} {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    write: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
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

describe('eval command', () => {
  it('scores --task and prints a record', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          task: 'fix the widget',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'standard',
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.join('\n')).toMatch(/swe-bench-mini/);
  });

  it('emits a jq-able --json envelope', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'standard',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      record: {
        suite: string;
        worktree: string;
        size: string;
        determinism: string;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.record.suite).toBe('swe-bench-mini');
    expect(envelope.record.size).toBe('standard');
    // The --task path executes a model-backed suite: the live tier.
    expect(envelope.record.determinism).toBe('live');
  });

  it('exits 2 when worktree/size are missing', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', task: 'fix', model: 'acme/m1' },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/worktree|size/i);
  });

  it('exits 2 on an invalid --workspace instead of coercing to inline', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'standard',
          workspace: 'worktreee',
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/workspace/i);
  });

  it('scores --trajectory without running a suite', async () => {
    const o = out();
    let ran = false;
    const trajectory = JSON.stringify({
      schema_version: '1.0',
      task: { taskId: 't', objective: 'fix', role: 'writer' },
      identity: { sessionId: 's', agentId: 'a' },
      model: { provider: 'acme', model: 'm1', thinking: null, escalations: [] },
      prompt: { text: 'fix' },
      resources: { skills: [] },
      actions: [],
      observations: [],
      state: { phase: 'done' },
      provenance: {
        sessionId: 's',
        agentId: 'a',
        pid: null,
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
      eval: { labels: {} },
    });
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          trajectory: trajectory,
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'standard',
        },
        {
          out: o.write,
          err: o.err,
          runSuite: async () => {
            ran = true;
            return { success: true, signals: signals() };
          },
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(ran).toBe(false);
    expect(o.lines.join('\n')).toMatch(/swe-bench-mini/);
    expect(o.lines.join('\n')).toMatch(/determinism=recorded/);
  });
});

describe('eval --trajectory provenance', () => {
  const exported = JSON.stringify(makeExport({ model: 'acme/m1' }));

  it('records the export provenance when no provenance flags are given', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          trajectory: exported,
          size: 'standard',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      record: {
        model: string;
        worktree: string;
        caseId: string;
        determinism: string;
      };
    };
    expect(envelope.record).toMatchObject({
      model: 'acme/m1',
      worktree: '/wt/agent-1',
      caseId: 'swe-bench-mini',
      // Scoring an existing export re-executes nothing.
      determinism: 'recorded',
    });
  });

  it('exits 1 when the trajectory gates fail, and the envelope follows it', async () => {
    const red = JSON.stringify(
      makeExport({
        model: 'acme/m1',
        evalLabels: { 'signal:tests': 'fail' },
      }),
    );
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          trajectory: red,
          size: 'standard',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(EXIT_FAILED);
    expect(o.errs).toEqual([]);
    expect(JSON.parse(o.lines.join('\n'))).toMatchObject({
      ok: false,
      exitCode: EXIT_FAILED,
      record: { success: false },
    });
  });

  it('exits 2 with provenance-mismatch on a conflicting --model and prints no record', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          trajectory: exported,
          model: 'faux/faux',
          size: 'standard',
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/\[provenance-mismatch\]/);
  });

  it('scores --task without a generation and keys the record by its suite', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          worktree: '/wt/a',
          size: 'standard',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      record: { caseId: string; generation?: number };
    };
    expect(envelope.record.caseId).toBe('swe-bench-mini');
    expect(envelope.record).not.toHaveProperty('generation');
  });
});

describe('benchmark command', () => {
  it('runs the full matrix: >=1 suite per category, stubs marked skipped', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        {
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'standard',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
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
      expect((stub as { skipped?: boolean }).skipped).toBe(true);
    }
    // Every row publishes the determinism tier it ran (or would
    // run) at.
    for (const row of envelope.results) {
      expect((row as { determinism?: string }).determinism).toBe('live');
    }
  });

  it('runs a single suite via --suite swe', async () => {
    const o = out();
    const ran: string[] = [];
    const exit = (
      await runBenchmarkCommand(
        {
          suite: 'swe-bench-mini',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
          workspace: 'worktree',
        },
        {
          ...deps,
          runSuite: async (suiteId: string) => {
            ran.push(suiteId);
            return deps.runSuite();
          },
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(ran).toEqual(['swe-bench-mini']);
    expect(o.lines.join('\n')).toMatch(/swe-bench-mini/);
  });

  it('refuses a stub-only matrix instead of reporting ok', async () => {
    const json = out();
    const exit = (
      await runBenchmarkCommand(
        {
          suite: 'terminal-live',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
          json: true,
        },
        { ...deps, out: json.write, err: json.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(json.errs).toEqual([]);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: 2,
      error: {
        code: 'no-executable-suites',
        message: 'benchmark: no executable suites selected',
      },
    });
    const text = out();
    const textExit = (
      await runBenchmarkCommand(
        {
          suite: 'terminal-live',
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
        },
        { ...deps, out: text.write, err: text.err },
      )
    ).exitCode;
    expect(textExit).toBe(2);
    expect(text.lines).toEqual([]);
    expect(text.errs).toEqual([
      'error: [no-executable-suites] benchmark: no executable suites selected',
    ]);
    expect(text.lines.join('\n')).not.toContain('ok');
  });

  it('validates provenance once before the matrix', async () => {
    // The stub branch never reached runEvalTask, so the size check was
    // skipped entirely and the run exited 0.
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        {
          suite: 'agentic-live',
          model: 'acme/m1',
          worktree: '/wt/a',
          json: true,
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.error.code).toBe('missing-size');
    expect(envelope.error.message).toMatch(/size is required/);
  });

  it('keeps a mixed matrix green when every executed suite passes', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        {
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.at(-1)).toBe(
      'benchmark ok: 7/7 suites passed, 1 stub(s) skipped',
    );
  });

  it('exits 2 on an invalid --workspace', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        {
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
          workspace: 'worktreee',
        },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs.join('\n')).toMatch(/workspace/i);
  });
});
