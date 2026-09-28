import { describe, expect, it } from 'vitest';
import type { AgentResult } from './result.js';
import {
  buildAgentResult,
  ERROR_KINDS,
  RESULT_FIELDS,
  RESULT_STATUSES,
  validateAgentResult,
} from './result.js';

function validResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: 'completed',
    summary: 'done',
    filesChanged: ['src/a.ts'],
    provenance: {
      workerId: 'worker-1',
      sessionId: 'orch-1-worker-1',
      pid: 4242,
      generation: 1,
      worktree: '/repo/.kubic/wt/orch-1/worker-1',
      model: 'faux/faux-1',
    },
    metrics: {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      toolCalls: 1,
      latencyMs: 10,
      wallMs: 12,
    },
    ...overrides,
  };
}

describe('agent result (issue #7, §68)', () => {
  it('status union is exactly the §68 six', () => {
    expect([...RESULT_STATUSES].sort()).toEqual([
      'budget_exhausted',
      'cancelled',
      'completed',
      'failed',
      'spawn_failed',
      'timeout',
    ]);
  });

  it('error kinds are exactly the §68 eight', () => {
    expect([...ERROR_KINDS].sort()).toEqual([
      'approval',
      'budget',
      'context',
      'model',
      'process',
      'provider',
      'tool',
      'workspace',
    ]);
  });

  it('field list matches §68 exactly', () => {
    expect(Object.keys(RESULT_FIELDS).sort()).toEqual([
      'approvals',
      'artifacts',
      'diff',
      'error',
      'escalations',
      'filesChanged',
      'findings',
      'metrics',
      'provenance',
      'status',
      'summary',
      'tests',
    ]);
  });

  it('accepts a minimal completed result', () => {
    expect(validateAgentResult(validResult()).valid).toBe(true);
  });

  it('accepts a failed result with error and provenance', () => {
    const result = validateAgentResult(
      validResult({
        status: 'failed',
        error: { kind: 'tool', message: 'bash exited 1' },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects any result missing provenance', () => {
    const { provenance: _dropped, ...noProv } = validResult();
    const result = validateAgentResult(noProv);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/provenance/);
  });

  it('rejects failed status missing error', () => {
    const result = validateAgentResult(validResult({ status: 'failed' }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/error/);
  });

  it('rejects error with a kind outside the eight', () => {
    const result = validateAgentResult(
      validResult({
        status: 'failed',
        error: { kind: 'unknown' as never, message: 'x' },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/kind/);
  });

  it('rejects filesChanged with non-string elements', () => {
    const result = validateAgentResult(
      validResult({ filesChanged: ['ok.ts', 42] as never }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/filesChanged/);
  });

  it('rejects NaN metric values', () => {
    const result = validateAgentResult(
      validResult({
        metrics: {
          inputTokens: Number.NaN,
          outputTokens: 1,
          cachedTokens: 0,
          toolCalls: 1,
          latencyMs: 10,
          wallMs: 12,
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.join(' ')).toMatch(/metrics\.inputTokens/);
  });

  it('rejects a transcript field — results never carry transcripts', () => {
    const result = validateAgentResult({ ...validResult(), transcript: '...' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/transcript/);
  });

  it('JSON round-trip preserves validity and shape', () => {
    const task = validResult({ status: 'timeout', findings: ['slow'] });
    const revived: unknown = JSON.parse(JSON.stringify(task));
    const result = validateAgentResult(revived);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.task).toEqual(task);
  });
});

describe('§68 provenance is fleshed out (issue #185)', () => {
  it.each(['sessionId', 'pid', 'generation', 'worktree', 'model'])(
    'rejects a result missing provenance.%s',
    (field) => {
      const result = validResult();
      const provenance = { ...result.provenance } as Record<string, unknown>;
      delete provenance[field];
      const checked = validateAgentResult({ ...result, provenance });
      expect(checked.valid).toBe(false);
      if (!checked.valid) {
        expect(checked.errors.join('\n')).toContain(`provenance.${field}`);
      }
    },
  );

  it('accepts a null pid (a spawn that never produced a process)', () => {
    const result = validResult({
      status: 'spawn_failed',
      error: { kind: 'process', message: 'never started' },
    });
    expect(
      validateAgentResult({
        ...result,
        provenance: { ...result.provenance, pid: null },
      }).valid,
    ).toBe(true);
  });

  it('refuses transcript AND messages keys (§69)', () => {
    const checked = validateAgentResult({ ...validResult(), messages: [] });
    expect(checked.valid).toBe(false);
  });

  it('buildAgentResult is the one builder: zero-fills metrics, validates, never carries a transcript', () => {
    const built = buildAgentResult({
      status: 'failed',
      summary: 'exited 6',
      provenance: validResult().provenance,
      metrics: { wallMs: 5, latencyMs: 1, inputTokens: 7 },
      error: { kind: 'provider', message: 'exited 6' },
    });
    expect(built.metrics).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cachedTokens: 0,
      toolCalls: 0,
      latencyMs: 1,
      wallMs: 5,
    });
    expect(built.filesChanged).toEqual([]);
    expect(Object.keys(built)).not.toContain('transcript');
    expect(Object.keys(built)).not.toContain('messages');
    expect(() =>
      buildAgentResult({
        status: 'failed',
        summary: 'no error',
        provenance: validResult().provenance,
        metrics: { wallMs: 0, latencyMs: 0 },
      }),
    ).toThrow(/§68/);
  });
});
