// The side-by-side comparison: each suite on each model, repeated; the
// per-model pass rate, cost, latency and tokens; a run that cannot run is
// named and fails the command, and a suite file is validated by name.
import { describe, expect, it } from 'vitest';
import { runCompareCommand, summarizeRuns } from './compare.js';
import type { SuiteRunOutcome } from './runner.js';
import type { EvalSignals } from './signals.js';
import { type FileSuite, suiteFromRecord } from './suite-files.js';

function signals(over: Partial<EvalSignals>): EvalSignals {
  return {
    tests: 'pass',
    build: 'unknown',
    lint: 'unknown',
    typecheck: 'unknown',
    completion: true,
    quality: 1,
    regressionFree: true,
    tokens: 1000,
    costUsd: 0.01,
    latencyMs: 2000,
    toolCalls: 1,
    toolCounts: {},
    escalations: 0,
    ...over,
  };
}

const SUITE: FileSuite = suiteFromRecord(
  { task: 'add the endpoint', gates: { tests: 'npm test' } },
  '/evals/endpoint.toml',
  'endpoint',
);

describe('suiteFromRecord', () => {
  it('reads a suite and names it after its file', () => {
    expect(SUITE).toMatchObject({
      id: 'endpoint',
      title: 'endpoint',
      task: 'add the endpoint',
      gates: { tests: 'npm test' },
    });
  });

  it('refuses a suite without a gate, an unknown key and an escaping file', () => {
    expect(() =>
      suiteFromRecord({ task: 't', gates: {} }, 's.toml', 's'),
    ).toThrow('[gates] names at least one of');
    expect(() =>
      suiteFromRecord(
        { task: 't', gates: { tests: 'x' }, prompt: 'p' },
        's.toml',
        's',
      ),
    ).toThrow('unknown key(s) prompt');
    expect(() =>
      suiteFromRecord(
        { task: 't', gates: { tests: 'x' }, files: { '../evil': 'x' } },
        's.toml',
        's',
      ),
    ).toThrow('must be a relative path inside the workspace');
  });
});

describe('summarizeRuns', () => {
  it('totals each model', () => {
    const [summary] = summarizeRuns(
      [
        {
          suite: 's',
          model: 'a/x',
          repetition: 1,
          success: true,
          costUsd: 0.02,
          tokens: 100,
          latencyMs: 1000,
        },
        {
          suite: 's',
          model: 'a/x',
          repetition: 2,
          success: false,
          costUsd: 0.04,
          tokens: 300,
          latencyMs: 3000,
        },
      ],
      ['a/x'],
    );
    expect(summary).toEqual({
      model: 'a/x',
      runs: 2,
      passed: 1,
      passRate: 0.5,
      costUsd: { total: 0.06, mean: 0.03 },
      latencyMs: { mean: 2000, p50: 2000 },
      tokens: { mean: 200 },
    });
  });
});

describe('runCompareCommand', () => {
  it('reports two models side by side', async () => {
    const out: string[] = [];
    const runFileSuite = async (
      _suite: FileSuite,
      model: string,
    ): Promise<SuiteRunOutcome> => ({
      success: true,
      signals: signals(
        model === 'a/strong'
          ? { tests: 'pass', costUsd: 0.05 }
          : { tests: 'fail', costUsd: 0.01 },
      ),
    });
    const result = await runCompareCommand(
      {
        suiteFile: ['/evals'],
        models: ['a/strong', 'b/cheap'],
        repeat: 2,
        json: false,
      },
      {
        out: (line) => out.push(line),
        err: (line) => out.push(line),
        loadSuiteFiles: () => [SUITE],
        runFileSuite,
      },
    );
    expect(result.exitCode).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/a\/strong\s+2\s+2\s+100%\s+\$0\.0500/);
    expect(text).toMatch(/b\/cheap\s+2\s+0\s+0%\s+\$0\.0100/);
    expect(text).toMatch(/endpoint\s+2\/2\s+0\/2/);
    expect(text).toContain('compare: 1 suite(s) × 2 model(s) × 2 run(s) each');
  });

  it('names a run that could not run, and fails', async () => {
    const out: string[] = [];
    const result = await runCompareCommand(
      { suiteFile: ['/evals'], models: ['a/x'], repeat: 1, json: true },
      {
        out: (line) => out.push(line),
        err: () => undefined,
        loadSuiteFiles: () => [SUITE],
        runFileSuite: async () => {
          throw new Error('unknown model');
        },
      },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(out.join('\n'));
    expect(envelope.runs[0]).toMatchObject({ error: 'unknown model' });
  });

  it('refuses a repeat out of bounds', async () => {
    const err: string[] = [];
    const result = await runCompareCommand(
      { suiteFile: ['/evals'], models: ['a/x'], repeat: 0, json: false },
      {
        out: () => undefined,
        err: (line) => err.push(line),
        loadSuiteFiles: () => [SUITE],
        runFileSuite: async () => {
          throw new Error('not reached');
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(err.join('\n')).toContain(
      '--repeat must be an integer from 1 to 20',
    );
  });
});
