import { describe, expect, it } from 'vitest';
import {
  type EvalRecordInput,
  reconcileUsage,
  validateEvalRecord,
} from './records.js';

function input(overrides: Partial<EvalRecordInput> = {}): EvalRecordInput {
  return {
    suite: 'swe-bench-mini',
    caseId: 'case-1',
    category: 'swe',
    success: true,
    costUsd: 0.02,
    tokens: 150,
    latencyMs: 60000,
    toolCalls: 3,
    model: 'acme/m1',
    thinking: null,
    worktree: '/wt/agent-1',
    generation: 3,
    tier: 'standard',
    ...overrides,
  };
}

describe('validateEvalRecord (issue #53)', () => {
  it('accepts a complete record', () => {
    const result = validateEvalRecord(input());
    expect(result.valid).toBe(true);
  });

  it('rejects a record missing worktree, without storing it', () => {
    const { worktree: _dropped, ...rest } = input();
    const result = validateEvalRecord(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/worktree/i);
      expect(result.record).toBeUndefined();
    }
  });

  it('rejects a record missing generation or tier', () => {
    const noGeneration = validateEvalRecord({
      ...input(),
      generation: undefined as unknown as number,
    });
    expect(noGeneration.valid).toBe(false);
    const noTier = validateEvalRecord({
      ...input(),
      tier: undefined as unknown as string,
    });
    expect(noTier.valid).toBe(false);
  });
});

describe('reconcileUsage §39 (issue #53)', () => {
  it('reconciles cost/tokens/latency against usage rows', () => {
    const check = reconcileUsage(input(), [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
    ]);
    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it('flags a cost mismatch', () => {
    const check = reconcileUsage(input({ costUsd: 0.05 }), [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
    ]);
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/cost/i);
  });

  it('flags a token mismatch', () => {
    const check = reconcileUsage(input({ tokens: 999 }), [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
    ]);
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/token/i);
  });
});
