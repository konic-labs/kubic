import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_USAGE } from '../../core/src/cli/exit-codes.js';
import { runBenchmarkCommand, runEvalCommand } from './cli.js';
import { EvalRunnerError } from './runner.js';
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
  const exported = JSON.stringify(
    makeExport({ model: 'acme/m1', generation: 3 }),
  );

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
        generation: number;
        determinism: string;
      };
    };
    expect(envelope.record).toMatchObject({
      model: 'acme/m1',
      worktree: '/wt/agent-1',
      generation: 3,
      // Scoring an existing export re-executes nothing.
      determinism: 'recorded',
    });
  });

  it('exits 1 when the trajectory gates fail, and the envelope follows it', async () => {
    const red = JSON.stringify(
      makeExport({
        model: 'acme/m1',
        generation: 3,
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

  it('scores --task with no generation flag and records generation 0', async () => {
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
      record: { generation: number };
    };
    expect(envelope.record.generation).toBe(0);
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

describe('eval/benchmark semantics over parsed options', () => {
  const PROVENANCE = {
    model: 'acme/m1',
    worktree: '/wt/a',
    size: 'standard',
  };

  it('prints the record line on stdout and nothing on stderr', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatch(
      /^eval ok: suite swe-bench-mini success=true .* model=acme\/m1 worktree=\/wt\/a size=standard determinism=live$/,
    );
    expect(o.errs).toEqual([]);
  });

  it('defaults the model to the shipped testing provider (faux/echo)', async () => {
    const o = out();
    const { model: _model, ...rest } = PROVENANCE;
    await runEvalCommand(
      { suite: 'swe-bench-mini', task: 'fix', ...rest },
      { ...deps, out: o.write, err: o.err },
    );
    expect(o.lines[0]).toMatch(/ model=faux\/echo /);
  });

  it('needs --suite and one of --task/--trajectory', async () => {
    const noSuite = out();
    expect(
      (
        await runEvalCommand(
          { task: 'fix', ...PROVENANCE },
          { ...deps, out: noSuite.write, err: noSuite.err },
        )
      ).exitCode,
    ).toBe(2);
    expect(noSuite.errs).toEqual([
      "error: required option '--suite <id>' not specified",
    ]);
    const noWork = out();
    expect(
      (
        await runEvalCommand(
          { suite: 'swe-bench-mini', ...PROVENANCE },
          { ...deps, out: noWork.write, err: noWork.err },
        )
      ).exitCode,
    ).toBe(2);
    expect(noWork.errs).toEqual([
      'error: one of --task <prompt> or --trajectory <json> is required',
    ]);
  });

  it('refuses a malformed inline --trajectory by name (back-compat form)', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: '{not json', ...PROVENANCE },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.errs[0]).toMatch(/^error: \[trajectory-malformed\] /);
    expect(o.errs[0]).toMatch(/inline JSON is malformed/);
  });

  it('scores a --trajectory FILE', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: 'run.json', ...PROVENANCE },
        {
          ...deps,
          readFile: (path: string) => {
            expect(path).toBe('run.json');
            // PROVENANCE's worktree must agree with the export's.
            return JSON.stringify(makeExport({ worktree: '/wt/a' }));
          },
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.join('\n')).toMatch(/determinism=recorded/);
  });

  it('reads --trajectory - from stdin', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: '-', ...PROVENANCE },
        {
          ...deps,
          readStdin: () => JSON.stringify(makeExport({ worktree: '/wt/a' })),
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines.join('\n')).toMatch(/determinism=recorded/);
  });

  it('names an unreadable trajectory file (trajectory-unreadable, exit 2)', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: 'missing.json', ...PROVENANCE },
        {
          ...deps,
          readFile: () => {
            throw new Error('ENOENT: no such file');
          },
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs).toEqual([
      'error: [trajectory-unreadable] cannot read trajectory "missing.json": ENOENT: no such file',
    ]);
  });

  it('names a malformed trajectory file (trajectory-malformed, exit 2)', async () => {
    for (const [body, message] of [
      ['{not json', /is not valid JSON/],
      ['{}', /is not a valid export/],
    ] as const) {
      const o = out();
      const exit = (
        await runEvalCommand(
          { suite: 'swe-bench-mini', trajectory: 'bad.json', ...PROVENANCE },
          { ...deps, readFile: () => body, out: o.write, err: o.err },
        )
      ).exitCode;
      expect(exit, body).toBe(2);
      expect(o.lines, body).toEqual([]);
      expect(o.errs[0], body).toMatch(/^error: \[trajectory-malformed\] /);
      expect(o.errs[0], body).toMatch(message);
    }
  });

  it('refuses a file path when the caller supplied no reader', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: 'run.json', ...PROVENANCE },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.errs[0]).toMatch(/^error: \[trajectory-unreadable\] /);
    expect(o.errs[0]).toMatch(/no file reader/);
  });

  it('names a record-validation failure invalid-record', async () => {
    const broken = {
      runSuite: async () => ({
        success: true,
        signals: { ...signals(), costUsd: -1 },
        usageRows: [
          { inputTokens: 100, outputTokens: 50, costUsd: -1, latencyMs: 60000 },
        ],
      }),
    };
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE, json: true },
        { ...broken, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('invalid-record');
    expect(envelope.error.message).toMatch(/costUsd/);
  });

  it('keeps the benchmark refusal code and its completed rows', async () => {
    let calls = 0;
    const halfRed = {
      runSuite: async () => {
        calls += 1;
        if (calls === 2) {
          throw new EvalRunnerError(
            'dirty-worktree',
            'worktree "/wt/a" is not clean — refusing to benchmark against a dirty tree',
          );
        }
        return {
          success: true,
          signals: signals(),
          usageRows: [
            {
              inputTokens: 100,
              outputTokens: 50,
              costUsd: 0.02,
              latencyMs: 60000,
            },
          ],
        };
      },
    };
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        {
          model: 'acme/m1',
          worktree: '/wt/a',
          size: 'smoke',
          json: true,
        },
        { ...halfRed, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    const envelope = JSON.parse(o.lines.join('\n')) as {
      ok: boolean;
      error: { code: string };
      results: Array<{ suite: string; success: boolean }>;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('dirty-worktree');
    // The suites that already completed are reported, not dropped.
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0]).toMatchObject({
      suite: 'swe-bench-mini',
      success: true,
    });
  });

  it('exits 2 with the named refusal in the --json envelope', async () => {
    const o = out();
    const exit = (
      await runEvalCommand(
        { suite: 'terminal-live', task: 'fix', ...PROVENANCE, json: true },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(EXIT_USAGE);
    expect(o.errs).toEqual([]);
    expect(JSON.parse(o.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: EXIT_USAGE,
      error: {
        code: 'stub-suite',
        message:
          'suite "terminal-live" is a stub — refusing to score unimplemented work',
      },
    });
  });

  it('exits 1 when the record gates fail, and the envelope follows it', async () => {
    const red = {
      runSuite: async () => ({
        success: false,
        signals: signals(),
        usageRows: [
          {
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.02,
            latencyMs: 60000,
          },
        ],
      }),
    };
    const text = out();
    const textExit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE },
        { ...red, out: text.write, err: text.err },
      )
    ).exitCode;
    expect(textExit).toBe(EXIT_FAILED);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0]).toMatch(
      /^eval ok: suite swe-bench-mini success=false /,
    );
    expect(text.errs).toEqual([]);
    const json = out();
    const jsonExit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE, json: true },
        { ...red, out: json.write, err: json.err },
      )
    ).exitCode;
    expect(jsonExit).toBe(EXIT_FAILED);
    expect(json.errs).toEqual([]);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: EXIT_FAILED,
      record: expect.objectContaining({ success: false }),
    });
  });

  it('wraps a benchmark runner failure in the --json envelope', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        { suite: 'swe-bench-mini', ...PROVENANCE, json: true },
        {
          runSuite: async () => {
            throw new Error('suite exploded');
          },
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(exit).toBe(EXIT_USAGE);
    expect(o.errs).toEqual([]);
    expect(JSON.parse(o.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: EXIT_USAGE,
      error: { code: 'eval-failed', message: 'suite exploded' },
      // The refusal keeps the rows already completed.
      results: [],
    });
  });

  it('exits 1 with ok:false when an executed benchmark suite fails, reporting every suite', async () => {
    const oneRed = {
      runSuite: async (suiteId: string) => ({
        success: suiteId !== 'bugfix-repro',
        signals: signals(),
        usageRows: [
          {
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.02,
            latencyMs: 60000,
          },
        ],
      }),
    };
    const json = out();
    const jsonExit = (
      await runBenchmarkCommand(
        { ...PROVENANCE, json: true },
        { ...oneRed, out: json.write, err: json.err },
      )
    ).exitCode;
    expect(jsonExit).toBe(EXIT_FAILED);
    const envelope = JSON.parse(json.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      results: Array<{
        suite: string;
        stub: boolean;
        skipped: boolean;
        success: boolean;
      }>;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(EXIT_FAILED);
    expect(envelope.results).toHaveLength(8);
    expect(
      envelope.results.map((r) => `${r.suite}:${r.skipped}:${r.success}`),
    ).toEqual([
      'swe-bench-mini:false:true',
      'repo-mod-rename:false:true',
      'bugfix-repro:false:false',
      'refactor-extract:false:true',
      'testgen-cover:false:true',
      'review-diff:false:true',
      'terminal-live:true:false',
      'agentic-live:false:true',
    ]);
    const text = out();
    const textExit = (
      await runBenchmarkCommand(
        { ...PROVENANCE },
        { ...oneRed, out: text.write, err: text.err },
      )
    ).exitCode;
    expect(textExit).toBe(EXIT_FAILED);
    expect(text.lines[0]).toMatch(/bugfix-repro +bugfix +FAIL/);
    expect(text.lines[0]).toMatch(/swe-bench-mini +swe +pass/);
    expect(text.lines.at(-1)).toBe(
      'benchmark FAILED: 6/7 suites passed, 1 stub(s) skipped',
    );
    expect(text.errs).toEqual([]);
  });

  it('reports a runner failure on stderr off --json, as an envelope under --json', async () => {
    const failing = {
      runSuite: async (): Promise<never> => {
        throw new Error('suite exploded');
      },
    };
    const text = out();
    expect(
      (
        await runEvalCommand(
          { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE },
          { ...failing, out: text.write, err: text.err },
        )
      ).exitCode,
    ).toBe(1);
    expect(text.lines).toEqual([]);
    expect(text.errs).toEqual(['error: suite exploded']);
    const json = out();
    expect(
      (
        await runEvalCommand(
          { suite: 'swe-bench-mini', task: 'fix', ...PROVENANCE, json: true },
          { ...failing, out: json.write, err: json.err },
        )
      ).exitCode,
    ).toBe(1);
    expect(json.errs).toEqual([]);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      ok: false,
      exitCode: 1,
      error: { code: 'eval-failed', message: 'suite exploded' },
    });
  });

  it('renders the benchmark matrix as a table plus the verdict', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        { suite: 'swe-bench-mini', ...PROVENANCE },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(o.lines).toEqual([
      [
        'SUITE           CATEGORY  STATUS',
        'swe-bench-mini  swe       pass',
      ].join('\n'),
      'benchmark ok: 1/1 suites passed, 0 stub(s) skipped',
    ]);
    expect(o.errs).toEqual([]);
  });

  it('draws the benchmark kit table (header rule) only when fancy', async () => {
    const o = out();
    await runBenchmarkCommand(
      { suite: 'swe-bench-mini', ...PROVENANCE },
      { ...deps, out: o.write, err: o.err, fancy: true },
    );
    expect(o.lines.join('\n')).toMatch(/\n─+\n/);
    expect(o.lines.join('\n')).not.toContain('┌');
  });

  it('refuses an unknown benchmark suite by name on stderr', async () => {
    const o = out();
    const exit = (
      await runBenchmarkCommand(
        { suite: 'nope', ...PROVENANCE },
        { ...deps, out: o.write, err: o.err },
      )
    ).exitCode;
    expect(exit).toBe(2);
    expect(o.lines).toEqual([]);
    expect(o.errs).toEqual(['error: [unknown-suite] unknown suite "nope"']);
  });
});
