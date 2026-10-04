// §68 on the prod orchestrate path: a worker that exits 0 is not a success
// until its own report is read and the AgentResult built from it passes
// validateAgentResult. A missing, unparseable, not-ok, or foreign-session
// report is a typed `result_invalid` failure — never a silent success.
import { describe, expect, it } from 'vitest';
import {
  WorkerRunFailure,
  workerFailureResult,
  workerResultFromRun,
} from '../../../apps/kubic/src/orchestrate-run.js';

const envelope = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: true,
    exitCode: 0,
    sessionId: 's-w1',
    status: 'completed',
    result: { summary: 'did the work' },
    ...over,
  });

const run = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });

// What the orchestrator itself observed about the launch (issue #185).
const OBSERVED = {
  filesChanged: [] as string[],
  wallMs: 1,
  latencyMs: 0,
  provenance: {
    sessionId: 's-w1',
    pid: 4242,
    generation: 1,
    worktree: '/repo/.kubic/wt/orch-1/w1',
    role: 'implementer',
  },
};

describe('workerResultFromRun (§68)', () => {
  it('builds a validated AgentResult from the child report', () => {
    const out = workerResultFromRun(
      'w1',
      's-w1',
      run(`noise\n${envelope()}\n`),
      { ...OBSERVED, filesChanged: ['a.txt'], wallMs: 12, latencyMs: 3 },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.status).toBe('completed');
    expect(out.result.summary).toBe('did the work');
    expect(out.result.filesChanged).toEqual(['a.txt']);
    expect(out.result.provenance.workerId).toBe('w1');
  });

  it.each([
    ['no report at all', ''],
    ['a non-JSON last line', 'all done!'],
    ['a report that is not ok', envelope({ ok: false })],
    ['a report that is not completed', envelope({ status: 'failed' })],
    ['a report for another session', envelope({ sessionId: 'other' })],
    ['a report with an empty summary', envelope({ result: { summary: '' } })],
  ])('refuses %s as result_invalid', (_label, stdout) => {
    const out = workerResultFromRun('w1', 's-w1', run(stdout), OBSERVED);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('result_invalid');
    expect(out.error.message).toMatch(/§68/);
  });
});

describe('the §68 result is complete (issue #185)', () => {
  it('fills metrics from the child report usage, never zeros', () => {
    const out = workerResultFromRun(
      'w1',
      's-w1',
      run(
        envelope({
          model: 'faux/faux-1',
          usage: {
            ref: 'usage:s-w1',
            input: 120,
            output: 30,
            cacheRead: 7,
            cacheWrite: 0,
            costUsd: 0.25,
            toolCalls: 3,
          },
        }),
      ),
      OBSERVED,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.metrics).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 7,
      toolCalls: 3,
      costUsd: 0.25,
    });
    expect(out.result.provenance).toEqual({
      workerId: 'w1',
      sessionId: 's-w1',
      pid: 4242,
      generation: 1,
      worktree: '/repo/.kubic/wt/orch-1/w1',
      role: 'implementer',
      model: 'faux/faux-1',
    });
    expect(Object.keys(out.result)).not.toContain('transcript');
    expect(Object.keys(out.result)).not.toContain('messages');
  });

  it('a non-zero-exit worker still yields a result with full provenance and error.kind', () => {
    const failure = new WorkerRunFailure(
      'worker_failed',
      'worker run exited 6: no models available',
    );
    const result = workerFailureResult(
      'w1',
      failure,
      {
        exitCode: 6,
        stdout: JSON.stringify({
          ok: false,
          exitCode: 6,
          sessionId: 's-w1',
          status: 'provider_probe_failed',
          result: { summary: 'no models' },
          model: 'faux/faux-1',
        }),
        stderr: '',
      },
      OBSERVED,
      { code: 'provider_auth', kind: 'provider', message: 'x' },
    );
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('provider');
    expect(result.provenance).toMatchObject({
      workerId: 'w1',
      pid: 4242,
      generation: 1,
      worktree: '/repo/.kubic/wt/orch-1/w1',
      model: 'faux/faux-1',
    });
  });

  it.each([
    ['spawn_failed', 'spawn_failed', 'process'],
    ['cancelled', 'cancelled', 'process'],
    ['result_invalid', 'failed', 'process'],
  ] as const)(
    'maps a %s terminus to status %s / kind %s',
    (code, status, kind) => {
      const result = workerFailureResult(
        'w1',
        new WorkerRunFailure(code, `${code} happened`),
        undefined,
        OBSERVED,
      );
      expect(result.status).toBe(status);
      expect(result.error?.kind).toBe(kind);
      expect(result.provenance.model).toBe('unresolved');
    },
  );

  it('maps a child budget terminus to budget_exhausted and an approval one to failed/approval', () => {
    const budget = workerFailureResult(
      'w1',
      new WorkerRunFailure('worker_failed', 'budget', {
        code: 'BUDGET_EXHAUSTED',
        exitCode: 3,
      }),
      undefined,
      OBSERVED,
    );
    expect(budget.status).toBe('budget_exhausted');
    expect(budget.error?.kind).toBe('budget');
    const denied = workerFailureResult(
      'w1',
      new WorkerRunFailure('worker_failed', 'denied', {
        code: 'approval_denied',
        exitCode: 4,
      }),
      undefined,
      OBSERVED,
    );
    expect(denied.status).toBe('failed');
    expect(denied.error?.kind).toBe('approval');
  });

  it('reads the child’s §52 failure code and kind instead of guessing from the exit code (issue #155)', () => {
    const result = workerFailureResult(
      'w1',
      new WorkerRunFailure(
        'worker_failed',
        'worker run exited 1: the model produced nothing',
      ),
      {
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          exitCode: 1,
          sessionId: 's-w1',
          status: 'failed',
          result: { summary: 'the model produced nothing' },
          error: { kind: 'model', message: 'the model produced nothing' },
          failure: {
            code: 'model_failed',
            remedy: 'inspect the model error',
            strategy: 'retry_same',
          },
        }),
        stderr: '',
      },
      OBSERVED,
    );
    // Exit 1 alone would have said process_crashed; the child's own report
    // names the §52 code and its domain.
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('model');
    expect(result.error?.details).toMatchObject({ code: 'model_failed' });
  });

  it('maps a child timeout/cancelled report to its own §68 status (issue #280)', () => {
    for (const status of ['timeout', 'cancelled'] as const) {
      const result = workerFailureResult(
        'w1',
        new WorkerRunFailure('worker_failed', `worker run exited 1: ${status}`),
        {
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            exitCode: 1,
            sessionId: 's-w1',
            status,
            error: { kind: status, message: status },
          }),
          stderr: '',
        },
        OBSERVED,
      );
      // The child's own report names the terminus; a wall-clock timeout is
      // not a budget breach (§71) and a cancellation is not a failure.
      expect(result.status, status).toBe(status);
    }
  });
});
