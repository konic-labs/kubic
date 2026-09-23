// Parallel limits (issue #47): default concurrency 4, aggregate + provider
// + budget gates. RED first — implementation lands in limits.ts.
import { describe, expect, it } from 'vitest';
import {
  checkAggregateAdmission,
  checkBudgetAdmission,
  checkProviderAdmission,
  DEFAULT_MAX_CONCURRENCY,
  isAggregateConfigured,
  isBudgetGateConfigured,
  ParallelConfigError,
  resolveMaxConcurrency,
  resolveWorkerCapacity,
  sanitizeReasonField,
  validateParallelLimits,
} from './limits.js';

describe('parallel concurrency default (issue #47)', () => {
  it('defaults to 4 with nothing configured', () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
    expect(resolveMaxConcurrency()).toBe(4);
    expect(resolveMaxConcurrency({})).toBe(4);
  });

  it('honors a per-session override', () => {
    expect(resolveMaxConcurrency({}, 2)).toBe(2);
    expect(resolveMaxConcurrency({ maxConcurrency: 6 }, 2)).toBe(2);
  });

  it('rejects non-positive concurrency instead of smuggling one', () => {
    expect(() => resolveMaxConcurrency({ maxConcurrency: 0 })).toThrow(
      /maxConcurrency/,
    );
    expect(() => resolveMaxConcurrency({}, 0)).toThrow(/maxConcurrency/);
  });
});

describe('parallel aggregate gates (issue #47)', () => {
  it('treats absent caps as unconfigured — never a default', () => {
    expect(isAggregateConfigured(undefined)).toBe(false);
    expect(isAggregateConfigured({})).toBe(false);
    expect(isAggregateConfigured({ maxMemMb: 8192 })).toBe(true);
  });

  it('blocks a heavy spawn when the mem aggregate would overflow', () => {
    const running = [{ memMb: 2048 }, { memMb: 2048 }];
    const blocked = checkAggregateAdmission(
      running,
      { memMb: 5120 },
      { maxMemMb: 8192 },
    );
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) expect(blocked.reason).toMatch(/mem/);
  });

  it('passes per-agent-light spawns until the aggregate fills', () => {
    // Boundary: exactly at cap admits (4×2GB fits an 8GB aggregate per §45),
    // anything over blocks even though each agent alone is light.
    const caps = { maxMemMb: 8192 };
    expect(
      checkAggregateAdmission(
        [{ memMb: 2048 }, { memMb: 2048 }, { memMb: 2048 }],
        { memMb: 2048 },
        caps,
      ).admitted,
    ).toBe(true);
    expect(
      checkAggregateAdmission(
        [{ memMb: 2048 }, { memMb: 2048 }, { memMb: 2048 }],
        { memMb: 2049 },
        caps,
      ).admitted,
    ).toBe(false);
  });

  it('blocks on disk aggregate overflow with a disk reason', () => {
    const blocked = checkAggregateAdmission(
      [{ diskMb: 900 }],
      { diskMb: 200 },
      { maxDiskMb: 1024 },
    );
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) expect(blocked.reason).toMatch(/disk/);
  });

  it('admits everything when no aggregate is configured', () => {
    expect(
      checkAggregateAdmission([{ memMb: 99999 }], { memMb: 99999 }, undefined)
        .admitted,
    ).toBe(true);
  });
});

describe('parallel provider caps (issue #47)', () => {
  it('admits when no cap is configured for the provider', () => {
    expect(
      checkProviderAdmission('acme', 99, [], undefined, 1000).admitted,
    ).toBe(true);
  });

  it('blocks past maxConcurrent with a provider reason', () => {
    const blocked = checkProviderAdmission(
      'acme',
      2,
      [],
      { maxConcurrent: 2 },
      1000,
    );
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) expect(blocked.reason).toMatch(/acme/);
  });

  it('blocks past the rate window using only in-window stamps', () => {
    const cap = { maxPerWindow: 2, windowMs: 60_000 };
    const blocked = checkProviderAdmission(
      'acme',
      0,
      [1000, 2000, 120_000],
      cap,
      121_000,
    );
    expect(blocked.admitted).toBe(true);
    const over = checkProviderAdmission(
      'acme',
      0,
      [119_000, 120_000],
      cap,
      121_000,
    );
    expect(over.admitted).toBe(false);
  });
});

describe('parallel budget gates opt-in (issue #47, §71)', () => {
  it('treats absent/empty gates as unconfigured', () => {
    expect(isBudgetGateConfigured(undefined)).toBe(false);
    expect(isBudgetGateConfigured({})).toBe(false);
    expect(isBudgetGateConfigured({ maxCostUsd: 5 })).toBe(true);
  });

  it('passes everything when no budget gate is configured', () => {
    expect(
      checkBudgetAdmission({ costUsd: 999, tokens: 999 }, undefined).admitted,
    ).toBe(true);
  });

  it('blocks cost overrun only when a cost gate is configured', () => {
    const blocked = checkBudgetAdmission({ costUsd: 6 }, { maxCostUsd: 5 });
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) expect(blocked.reason).toMatch(/cost/);
    expect(
      checkBudgetAdmission({ costUsd: 4 }, { maxCostUsd: 5 }).admitted,
    ).toBe(true);
  });
});

describe('parallel deny-reason sanitize-at-source (issue #47)', () => {
  it('sanitizes a crafted provider name in the deny reason (sanitize-at-source)', () => {
    const evil = 'acme\u001b[2J-evil';
    const blocked = checkProviderAdmission(
      evil,
      1,
      [],
      { maxConcurrent: 1 },
      1000,
    );
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) {
      expect(blocked.reason.includes('\u001b')).toBe(false);
      expect(blocked.reason.includes(evil)).toBe(false);
    }
  });
});

describe('parallel budget gates per-dim (issue #70 mutation E/F)', () => {
  it('recognizes each budget field as a configured gate', () => {
    expect(isBudgetGateConfigured({ maxTokens: 10 })).toBe(true);
    expect(isBudgetGateConfigured({ maxToolCalls: 10 })).toBe(true);
    expect(isBudgetGateConfigured({ maxRuntimeMs: 10 })).toBe(true);
  });

  it('blocks token/tool-call/runtime overruns with a naming reason', () => {
    for (const [usage, gate, pattern] of [
      [{ tokens: 11 }, { maxTokens: 10 }, /token/],
      [{ toolCalls: 6 }, { maxToolCalls: 5 }, /tool-call/],
      [{ runtimeMs: 2001 }, { maxRuntimeMs: 2000 }, /runtime/],
    ] as const) {
      const blocked = checkBudgetAdmission(usage, gate);
      expect(blocked.admitted).toBe(false);
      if (!blocked.admitted) expect(blocked.reason).toMatch(pattern);
    }
  });

  it('admits usage exactly at each gate — over by one denies', () => {
    expect(
      checkBudgetAdmission({ tokens: 10 }, { maxTokens: 10 }).admitted,
    ).toBe(true);
    expect(
      checkBudgetAdmission({ toolCalls: 5 }, { maxToolCalls: 5 }).admitted,
    ).toBe(true);
    expect(
      checkBudgetAdmission({ runtimeMs: 2000 }, { maxRuntimeMs: 2000 })
        .admitted,
    ).toBe(true);
    expect(
      checkBudgetAdmission({ tokens: 11 }, { maxTokens: 10 }).admitted,
    ).toBe(false);
  });

  it('treats absent usage fields as zero — never NaN-blocks', () => {
    expect(checkBudgetAdmission({}, { maxTokens: 10 }).admitted).toBe(true);
    expect(checkBudgetAdmission({}, { maxCostUsd: 5 }).admitted).toBe(true);
    expect(checkBudgetAdmission({}, { maxToolCalls: 5 }).admitted).toBe(true);
    expect(checkBudgetAdmission({}, { maxRuntimeMs: 5 }).admitted).toBe(true);
  });
});

describe('parallel worker capacity + validation (issue #70 mutation E/F)', () => {
  it('defaults worker slots to the resolved concurrency', () => {
    expect(resolveWorkerCapacity()).toBe(4);
    expect(resolveWorkerCapacity({ maxConcurrency: 6 })).toBe(6);
    expect(resolveWorkerCapacity({}, 2)).toBe(2);
    expect(
      resolveWorkerCapacity({ workerCapacity: 8, maxConcurrency: 6 }),
    ).toBe(8);
  });

  it('rejects bad worker/concurrency values as ParallelConfigError', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveMaxConcurrency({ maxConcurrency: bad })).toThrow(
        ParallelConfigError,
      );
      expect(() => resolveWorkerCapacity({ workerCapacity: bad })).toThrow(
        ParallelConfigError,
      );
      expect(() => resolveMaxConcurrency({}, bad)).toThrow(ParallelConfigError);
    }
  });

  it('accepts empty limits and zero approval/maxPending budgets', () => {
    expect(() => validateParallelLimits()).not.toThrow();
    expect(() => validateParallelLimits({})).not.toThrow();
    expect(() =>
      validateParallelLimits({ approvalCapacity: 0, maxPendingMs: 0 }),
    ).not.toThrow();
  });

  it('throws naming the field for bad caps', () => {
    expect(() => validateParallelLimits({ maxPendingMs: -1 })).toThrow(
      /maxPendingMs/,
    );
    expect(() =>
      validateParallelLimits({ aggregates: { maxMemMb: 0 } }),
    ).toThrow(/aggregates\.maxMemMb/);
    expect(() =>
      validateParallelLimits({
        providerCaps: { acme: { maxConcurrent: 0 } },
      }),
    ).toThrow(/maxConcurrent/);
    expect(() =>
      validateParallelLimits({ budgetGate: { maxTokens: -5 } }),
    ).toThrow(/budgetGate\.maxTokens/);
    expect(() => validateParallelLimits({ approvalCapacity: -1 })).toThrow(
      /approvalCapacity/,
    );
    expect(() => validateParallelLimits({ approvalCapacity: 1.5 })).toThrow(
      ParallelConfigError,
    );
  });
});

describe('parallel provider admission exact (issue #70 mutation E/F)', () => {
  it('admits one below the concurrency cap, denies exactly at it', () => {
    expect(
      checkProviderAdmission('acme', 1, [], { maxConcurrent: 2 }, 1000)
        .admitted,
    ).toBe(true);
    expect(
      checkProviderAdmission('acme', 2, [], { maxConcurrent: 2 }, 1000)
        .admitted,
    ).toBe(false);
  });

  it('uses the 60s default window when windowMs is absent', () => {
    const cap = { maxPerWindow: 1 };
    expect(
      checkProviderAdmission('acme', 0, [1000], cap, 61_001).admitted,
    ).toBe(true);
    expect(
      checkProviderAdmission('acme', 0, [60_001], cap, 61_001).admitted,
    ).toBe(false);
  });

  it('strips controls and bidi overrides at the source', () => {
    expect(sanitizeReasonField('acme\u001b[2J\u202e-evil')).toBe(
      'acme[2J-evil',
    );
    expect(sanitizeReasonField('ok-name')).toBe('ok-name');
    expect(sanitizeReasonField(42)).toBe('42');
  });
});
