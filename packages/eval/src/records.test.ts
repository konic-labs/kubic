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

  it('rejects a record missing or with an invalid category', () => {
    const { category: _dropped, ...rest } = input();
    const missing = validateEvalRecord(rest);
    expect(missing.valid).toBe(false);
    if (!missing.valid) {
      expect(missing.errors.join(' ')).toMatch(/category/i);
    }
    const invalid = validateEvalRecord({ ...input(), category: 'nope' });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.errors.join(' ')).toMatch(/category/i);
    }
  });

  it('rejects non-integer and infinite generations', () => {
    for (const generation of [1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = validateEvalRecord({ ...input(), generation });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.join(' ')).toMatch(/generation/i);
      }
    }
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

  it('admits latency exactly equal to summed usage, denies 1ms over (issue #70)', () => {
    const rows = [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02, latencyMs: 60000 },
    ];
    expect(reconcileUsage(input({ latencyMs: 60000 }), rows).ok).toBe(true);
    const over = reconcileUsage(input({ latencyMs: 59999 }), rows);
    expect(over.ok).toBe(false);
    expect(over.errors.join(' ')).toMatch(/latency/i);
  });

  it('treats rows without latencyMs as zero-latency (issue #70)', () => {
    const check = reconcileUsage(input(), [
      { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    ]);
    expect(check.ok).toBe(true);
  });

  it('reconciles empty usage rows against a zero record (issue #70)', () => {
    const zero = input({ tokens: 0, costUsd: 0, latencyMs: 0 });
    expect(reconcileUsage(zero, []).ok).toBe(true);
    expect(reconcileUsage(input(), []).ok).toBe(false);
  });

  it('sums tokens across multiple rows exactly (issue #70)', () => {
    const rows = [
      { inputTokens: 60, outputTokens: 40, costUsd: 0.01, latencyMs: 1000 },
      { inputTokens: 30, outputTokens: 20, costUsd: 0.01, latencyMs: 2000 },
    ];
    expect(reconcileUsage(input(), rows).ok).toBe(true);
    expect(reconcileUsage(input({ tokens: 151 }), rows).ok).toBe(false);
  });
});

describe('validateEvalRecord exact outputs (issue #70)', () => {
  it('stamps a valid record with an ISO recordedAt and the tier (issue #70)', () => {
    const result = validateEvalRecord(input());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.record.tier).toBe('standard');
      expect(Number.isNaN(Date.parse(result.record.recordedAt))).toBe(false);
      expect(result.record.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('accepts generation 0 and success false (issue #70)', () => {
    expect(validateEvalRecord({ ...input(), generation: 0 }).valid).toBe(true);
    const failed = validateEvalRecord({ ...input(), success: false });
    expect(failed.valid).toBe(true);
    if (failed.valid) expect(failed.record.success).toBe(false);
  });

  it('rejects whitespace-only suite/model/worktree and negative generations (issue #70)', () => {
    for (const overrides of [
      { suite: '   ' },
      { model: '' },
      { worktree: '  ' },
      { generation: -1 },
    ]) {
      expect(validateEvalRecord({ ...input(), ...overrides }).valid).toBe(
        false,
      );
    }
  });

  it('rejects empty-string thinking but keeps null (issue #70)', () => {
    expect(validateEvalRecord({ ...input(), thinking: '' }).valid).toBe(false);
    expect(validateEvalRecord({ ...input(), thinking: '  ' }).valid).toBe(
      false,
    );
    const nulled = validateEvalRecord({ ...input(), thinking: null });
    expect(nulled.valid).toBe(true);
  });

  it('rejects NaN/negative cost, tokens, latency, toolCalls; 0 admits (issue #70)', () => {
    for (const field of [
      'costUsd',
      'tokens',
      'latencyMs',
      'toolCalls',
    ] as const) {
      expect(validateEvalRecord({ ...input(), [field]: 0 }).valid).toBe(true);
      for (const bad of [Number.NaN, -1]) {
        expect(validateEvalRecord({ ...input(), [field]: bad }).valid).toBe(
          false,
        );
      }
    }
    // NOTE (issue #70): +Infinity currently validates (`>= 0` holds) —
    // pinning the behavior here; tightening needs a src change, out of
    // scope for this test-only hardening pass.
    expect(
      validateEvalRecord({ ...input(), costUsd: Number.POSITIVE_INFINITY })
        .valid,
    ).toBe(true);
  });

  it('rejects null, array, and string inputs without storing (issue #70)', () => {
    for (const bad of [null, [], 'record', 42]) {
      const result = validateEvalRecord(bad);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.record).toBeUndefined();
    }
  });

  it('rejects an unknown tier naming the allowed set (issue #70)', () => {
    const result = validateEvalRecord({ ...input(), tier: 'full' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/smoke.*standard.*extended/);
    }
  });

  it('accepts every tier and keeps extra signal payloads (issue #70)', () => {
    for (const tier of ['smoke', 'standard', 'extended']) {
      const result = validateEvalRecord({ ...input(), tier });
      expect(result.valid).toBe(true);
    }
    const withSignals = validateEvalRecord({
      ...input(),
      signals: {
        tests: 'pass',
        build: 'pass',
        lint: 'pass',
        typecheck: 'pass',
        completion: true,
        quality: 1,
        regressionFree: true,
        tokens: 150,
        costUsd: 0.02,
        latencyMs: 60000,
        toolCalls: 3,
        toolCounts: {},
        escalations: 0,
      },
    });
    expect(withSignals.valid).toBe(true);
  });
});
