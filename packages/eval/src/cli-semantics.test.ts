import { EXIT_FAILED, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
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

  it('scores a --trajectory FILE whose escalation was recorded without endpoints', async () => {
    const o = out();
    const exported = makeExport({ worktree: '/wt/a' });
    const earlier = {
      ...exported,
      model: {
        ...exported.model,
        escalations: [
          { reason: 'context overflow', at: '2026-10-04T10:00:30.000Z' },
        ],
      },
    };
    const exit = (
      await runEvalCommand(
        { suite: 'swe-bench-mini', trajectory: 'run.json', ...PROVENANCE },
        {
          ...deps,
          readFile: () => JSON.stringify(earlier),
          out: o.write,
          err: o.err,
        },
      )
    ).exitCode;
    expect(o.errs).toEqual([]);
    expect(exit).toBe(0);
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
