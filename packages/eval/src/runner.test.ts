import { describe, expect, it } from 'vitest';
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

describe('runEvalTask (issue #53)', () => {
  it('builds a complete record from a faux suite run', async () => {
    const record = await runEvalTask(
      {
        suite: 'swe-bench-mini',
        task: 'fix the widget',
        model: 'acme/m1',
        thinking: null,
        worktree: '/wt/agent-1',
        generation: 3,
        tier: 'standard',
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
    expect(record.tier).toBe('standard');
    expect(record.tokens).toBe(150);
  });

  it('rejects a run missing worktree/generation/tier instead of storing', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '',
          generation: 3,
          tier: 'standard',
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
        tier: 'smoke',
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
          tier: 'smoke',
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
          tier: 'smoke',
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
          tier: 'smoke',
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
          tier: 'smoke',
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

  it('rejects a run whose signals do not reconcile with usage rows (§39)', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          tier: 'smoke',
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

  it('refuses a task-path run without usage rows (§39)', async () => {
    await expect(
      runEvalTask(
        {
          suite: 'swe-bench-mini',
          task: 'fix',
          model: 'acme/m1',
          thinking: null,
          worktree: '/wt/a',
          generation: 1,
          tier: 'smoke',
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
            tier: 'smoke',
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
        tier: 'smoke',
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

describe('runEvalTrajectory (issue #53)', () => {
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
      tier: 'standard',
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
      tier: 'standard',
    });
    expect(record.success).toBe(false);
  });

  it('exposes a machine-readable error code', () => {
    const error = new EvalRunnerError('missing-tier', 'tier missing');
    expect(error.exitCode).toBe(2);
    expect(error.toJSON().error.code).toBe('missing-tier');
  });
});
