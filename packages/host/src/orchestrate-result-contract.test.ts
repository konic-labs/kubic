// §68 on the prod orchestrate path: a worker that exits 0 is not a success
// until its own report is read and the AgentResult built from it passes
// validateAgentResult. A missing, unparseable, not-ok, or foreign-session
// report is a typed `result_invalid` failure — never a silent success.
import { describe, expect, it } from 'vitest';
import { workerResultFromRun } from '../../../apps/kubic/src/orchestrate-run.js';

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

describe('workerResultFromRun (§68)', () => {
  it('builds a validated AgentResult from the child report', () => {
    const out = workerResultFromRun(
      'w1',
      's-w1',
      run(`noise\n${envelope()}\n`),
      {
        filesChanged: ['a.txt'],
        wallMs: 12,
        latencyMs: 3,
      },
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
    const out = workerResultFromRun('w1', 's-w1', run(stdout), {
      filesChanged: [],
      wallMs: 1,
      latencyMs: 0,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('result_invalid');
    expect(out.error.message).toMatch(/§68/);
  });
});
