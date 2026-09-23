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
  resolveMaxConcurrency,
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
