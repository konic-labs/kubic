import { describe, expect, it } from 'vitest';
import { makeExport } from './rl/fixtures.js';
import { EvalRunnerError, runEvalTask, runEvalTrajectory } from './runner.js';
import type { EvalSignals } from './signals.js';

function signals(overrides: Partial<EvalSignals> = {}): EvalSignals {
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
    ...overrides,
  };
}

function usageRows() {
  return [
    { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
  ];
}

describe('runEvalTask refusals are specific', () => {
  const base = {
    suite: 'swe-bench-mini',
    task: 'fix',
    model: 'acme/m1',
    thinking: null,
    worktree: '/wt/a',
    generation: 3,
    size: 'standard',
    workspace: 'inline' as const,
  };
  const ok = {
    runSuite: async () => ({
      success: true,
      signals: signals(),
      usageRows: usageRows(),
    }),
  };

  it('refuses a blank worktree and a negative generation, accepts generation 0', async () => {
    await expect(
      runEvalTask({ ...base, worktree: '  ' }, ok),
    ).rejects.toMatchObject({
      code: 'missing-worktree',
      message: expect.stringMatching(/^worktree is required/),
    });
    await expect(
      runEvalTask({ ...base, generation: -1 }, ok),
    ).rejects.toMatchObject({
      code: 'missing-generation',
      message: expect.stringMatching(/^generation is required/),
    });
    const record = await runEvalTask({ ...base, generation: 0 }, ok);
    expect(record.generation).toBe(0);
  });

  it('explains a worktree-mode refusal with or without a checker', async () => {
    await expect(
      runEvalTask({ ...base, workspace: 'worktree' }, ok),
    ).rejects.toMatchObject({
      code: 'dirty-worktree',
      message:
        'worktree "/wt/a" has no cleanliness checker — refusing to benchmark without one',
    });
    await expect(
      runEvalTask(
        { ...base, workspace: 'worktree' },
        { ...ok, ensureCleanWorktree: () => false },
      ),
    ).rejects.toMatchObject({
      code: 'dirty-worktree',
      message:
        'worktree "/wt/a" is not clean — refusing to benchmark against a dirty tree',
    });
  });

  it('explains missing and mismatched usage rows', async () => {
    await expect(
      runEvalTask(base, {
        runSuite: async () => ({ success: true, signals: signals() }),
      }),
    ).rejects.toMatchObject({
      code: 'missing-usage-rows',
      message: expect.stringMatching(/^usage rows are required/),
    });
    await expect(
      runEvalTask(base, {
        runSuite: async () => ({
          success: true,
          signals: signals({ tokens: 999 }),
          usageRows: usageRows(),
        }),
      }),
    ).rejects.toMatchObject({
      code: 'usage-mismatch',
      message: expect.stringMatching(
        /^signals do not reconcile with usage rows: \S/,
      ),
    });
  });
});

describe('runEvalTask', () => {
  it('builds a complete record from a faux suite run', async () => {
    const record = await runEvalTask(
      {
        suite: 'swe-bench-mini',
        task: 'fix the widget',
        model: 'acme/m1',
        thinking: null,
        worktree: '/wt/agent-1',
        generation: 3,
        size: 'standard',
        workspace: 'inline',
      },
      {
        runSuite: async () => ({
          success: true,
          signals: signals(),
          usageRows: usageRows(),
        }),
      },
    );
    expect(record.suite).toBe('swe-bench-mini');
    expect(record.success).toBe(true);
    expect(record.worktree).toBe('/wt/agent-1');
    expect(record.generation).toBe(3);
    expect(record.size).toBe('standard');
    expect(record.tokens).toBe(150);
  });

  it('rejects a run missing worktree/generation/size instead of storing', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '',
          generation: 3,
          size: 'standard',
          workspace: 'inline',
        },
        { runSuite: async () => ({ success: true, signals: signals() }) },
      ),
    ).rejects.toMatchObject({ code: 'missing-worktree' });
  });

  it('passes the same suite in a clean worktree via --workspace worktree', async () => {
    const checked: string[] = [];
    const record = await runEvalTask(
      {
        suite: 'swe-bench-mini',
        task: 'fix',
        model: 'acme/m1',
        thinking: null,
        worktree: '/wt/clean',
        generation: 1,
        size: 'smoke',
        workspace: 'worktree',
      },
      {
        runSuite: async () => ({
          success: true,
          signals: signals(),
          usageRows: usageRows(),
        }),
        ensureCleanWorktree: (path: string) => {
          checked.push(path);
          return true;
        },
      },
    );
    expect(checked).toEqual(['/wt/clean']);
    expect(record.success).toBe(true);
    expect(record.worktree).toBe('/wt/clean');
  });

  it('refuses a dirty worktree', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/dirty',
          generation: 1,
          size: 'smoke',
          workspace: 'worktree',
        },
        {
          runSuite: async () => {
            throw new Error('runSuite must not run');
          },
          ensureCleanWorktree: () => false,
        },
      ),
    ).rejects.toMatchObject({ code: 'dirty-worktree' });
  });

  it('refuses workspace=worktree without a cleanliness checker', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/unchecked',
          generation: 1,
          size: 'smoke',
          workspace: 'worktree',
        },
        {
          runSuite: async () => {
            throw new Error('runSuite must not run');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'dirty-worktree' });
  });

  it('rejects an unknown suite', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'nope',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          size: 'smoke',
          workspace: 'inline',
        },
        {
          runSuite: async () => {
            throw new Error('runSuite must not run');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'unknown-suite' });
  });

  it('refuses to score a stub suite without running it', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'terminal-live',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          size: 'smoke',
          workspace: 'inline',
        },
        {
          runSuite: async () => {
            throw new Error('runSuite must not run');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'stub-suite' });
  });

  it('rejects a run whose signals do not reconcile with usage rows', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          size: 'smoke',
          workspace: 'inline',
        },
        {
          runSuite: async () => ({
            success: true,
            signals: signals({ costUsd: 0.05 }),
            usageRows: [
              {
                inputTokens: 100,
                outputTokens: 50,
                costUsd: 0.02,
                latencyMs: 60000,
              },
            ],
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'usage-mismatch' });
  });

  it('refuses a task-path run without usage rows', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          size: 'smoke',
          workspace: 'inline',
        },
        {
          runSuite: async () => ({ success: true, signals: signals() }),
        },
      ),
    ).rejects.toMatchObject({ code: 'missing-usage-rows' });
  });

  it('rejects non-integer and infinite generations at the API layer', async () => {
    for (const generation of [1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(
        runEvalTask(
          {
            suite: 'swe-bench-mini',
            task: 'fix',
            model: 'acme/m1',
            thinking: null,
            worktree: '/wt/a',
            generation,
            size: 'smoke',
            workspace: 'inline',
          },
          {
            runSuite: async () => ({
              success: true,
              signals: signals(),
              usageRows: usageRows(),
            }),
          },
        ),
      ).rejects.toMatchObject({ code: 'missing-generation' });
    }
  });

  it('stores success=false for a completed run with a red gate', async () => {
    const record = await runEvalTask(
      {
        suite: 'swe-bench-mini',
        task: 'fix',
        model: 'acme/m1',
        thinking: null,
        worktree: '/wt/a',
        generation: 1,
        size: 'smoke',
        workspace: 'inline',
      },
      {
        runSuite: async () => ({
          success: true,
          signals: signals({ tests: 'fail' }),
          usageRows: usageRows(),
        }),
      },
    );
    expect(record.success).toBe(false);
  });
});

describe('runEvalTrajectory', () => {
  it('scores a trajectory export without re-running it', async () => {
    const record = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: {
        schema_version: '1.0',
        task: { taskId: 't', objective: 'fix', role: 'writer' },
        identity: { sessionId: 's', agentId: 'a', workerId: 'w' },
        model: {
          provider: 'acme',
          model: 'm1',
          thinking: null,
          escalations: [],
        },
        prompt: { text: 'fix', constraints: [] },
        resources: { skills: [], promptTemplates: [] },
        transfer: null,
        actions: [{ seq: 1, tool: 'exec', args: null }],
        observations: [],
        state: { phase: 'done', snapshot: null },
        provenance: {
          sessionId: 's',
          agentId: 'a',
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
          requests: 1,
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
      },
      model: 'acme/m1',
      thinking: null,
      worktree: '/wt/agent-1',
      generation: 3,
      size: 'standard',
    });
    expect(record.success).toBe(true);
    expect(record.tokens).toBe(150);
    expect(record.toolCalls).toBe(1);
    expect(record.model).toBe('acme/m1');
  });

  it('stores success=false for a completed trajectory with a red gate', async () => {
    const record = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: {
        schema_version: '1.0',
        task: { taskId: 't', objective: 'fix', role: 'writer' },
        identity: { sessionId: 's', agentId: 'a', workerId: 'w' },
        model: {
          provider: 'acme',
          model: 'm1',
          thinking: null,
          escalations: [],
        },
        prompt: { text: 'fix', constraints: [] },
        resources: { skills: [], promptTemplates: [] },
        transfer: null,
        actions: [{ seq: 1, tool: 'exec', args: null }],
        observations: [],
        state: { phase: 'done', snapshot: null },
        provenance: {
          sessionId: 's',
          agentId: 'a',
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
          requests: 1,
          costUsd: 0.02,
          byModel: {},
        },
        result: {
          status: 'completed',
          summary: 'done',
          failureCategory: null,
          error: null,
        },
        eval: {
          suite: null,
          caseId: null,
          labels: { 'signal:tests': 'fail' },
        },
      },
      model: 'acme/m1',
      thinking: null,
      worktree: '/wt/agent-1',
      generation: 3,
      size: 'standard',
    });
    expect(record.success).toBe(false);
  });

  it('exposes a machine-readable error code', () => {
    const error = new EvalRunnerError('missing-size', 'size missing');
    expect(error.exitCode).toBe(2);
    expect(error.toJSON().error.code).toBe('missing-size');
  });
});

describe('runEvalTrajectory provenance comes from the export', () => {
  it('records the export provider/model, generation and worktree when no flags are given', async () => {
    const record = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: makeExport({ model: 'acme/m1', generation: 3 }),
      size: 'standard',
    });
    expect(record.model).toBe('acme/m1');
    expect(record.generation).toBe(3);
    expect(record.worktree).toBe('/wt/agent-1');
    expect(record.caseId).toBe('swe-bench-mini:3');
  });

  it('takes thinking from exported.model.thinking', async () => {
    const exported = makeExport();
    exported.model.thinking = 'high';
    const record = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: exported,
      size: 'standard',
    });
    expect(record.thinking).toBe('high');
    const none = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: makeExport(),
      size: 'standard',
    });
    expect(none.thinking).toBeNull();
  });

  it('accepts flags that agree with the export', async () => {
    const exported = makeExport();
    exported.model.thinking = 'low';
    const record = await runEvalTrajectory({
      suite: 'swe-bench-mini',
      trajectory: exported,
      model: 'acme/m1',
      thinking: 'low',
      worktree: '/wt/agent-1',
      generation: 3,
      size: 'standard',
    });
    expect(record.model).toBe('acme/m1');
    expect(record.thinking).toBe('low');
  });

  it.each([
    ['model', { model: 'faux/faux' }, /model/],
    ['worktree', { worktree: '/other' }, /worktree/],
    ['generation', { generation: 0 }, /generation/],
    ['thinking', { thinking: 'high' }, /thinking/],
  ] as const)(
    'refuses a conflicting %s flag with provenance-mismatch',
    async (_name, flags, pattern) => {
      const error = await runEvalTrajectory({
        suite: 'swe-bench-mini',
        trajectory: makeExport({ model: 'acme/m1', generation: 3 }),
        size: 'standard',
        ...flags,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EvalRunnerError);
      expect((error as EvalRunnerError).code).toBe('provenance-mismatch');
      expect((error as EvalRunnerError).exitCode).toBe(2);
      expect((error as EvalRunnerError).message).toMatch(pattern);
    },
  );

  it('refuses an unknown suite, a stub suite and a malformed export by code', async () => {
    const refusal = (options: Parameters<typeof runEvalTrajectory>[0]) =>
      runEvalTrajectory(options).catch((caught: unknown) => caught);
    const unknown = (await refusal({
      suite: 'nope',
      trajectory: makeExport(),
      size: 'smoke',
    })) as EvalRunnerError;
    expect(unknown.code).toBe('unknown-suite');
    expect(unknown.message).toBe('unknown suite "nope"');
    const stub = (await refusal({
      suite: 'terminal-live',
      trajectory: makeExport(),
      size: 'smoke',
    })) as EvalRunnerError;
    expect(stub.code).toBe('stub-suite');
    expect(stub.message).toMatch(/^suite "terminal-live" is a stub/);
    const malformed = (await refusal({
      suite: 'swe-bench-mini',
      trajectory: { schema_version: '1.0' },
      size: 'smoke',
    })) as EvalRunnerError;
    expect(malformed.code).toBe('invalid-trajectory');
    expect(malformed.message).toMatch(
      /^invalid trajectory export: trajectory is missing field/,
    );
  });

  it('refuses a blank or unknown size with distinct codes', async () => {
    await expect(
      runEvalTrajectory({
        suite: 'swe-bench-mini',
        trajectory: makeExport(),
        size: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'missing-size',
      message: expect.stringMatching(/^size is required/),
    });
    await expect(
      runEvalTrajectory({
        suite: 'swe-bench-mini',
        trajectory: makeExport(),
        size: 'bogus',
      }),
    ).rejects.toMatchObject({
      code: 'invalid-size',
      message: expect.stringMatching(/^unknown size "bogus"/),
    });
  });

  it('names the error class', () => {
    expect(new EvalRunnerError('missing-size', 'x').name).toBe(
      'EvalRunnerError',
    );
  });

  it('still requires a size (not recorded in the export)', async () => {
    await expect(
      runEvalTrajectory({ suite: 'swe-bench-mini', trajectory: makeExport() }),
    ).rejects.toMatchObject({ code: 'missing-size' });
  });
});
