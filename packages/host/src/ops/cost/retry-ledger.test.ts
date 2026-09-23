// (5) retry discipline: bounded separate budget §53 (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import { canRetry, chargeRetry, createRetryLedger } from './retry-ledger.js';

describe('retry discipline on a separate budget (issue #56)', () => {
  it('admits retries while attempts and cost remain', () => {
    const ledger = createRetryLedger({ maxAttempts: 3, maxCostUsd: 1 });
    expect(canRetry(ledger)).toBe(true);
    chargeRetry(ledger, 0.2);
    expect(ledger.attempts).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(0.2);
  });

  it('a flaky provider cannot eat the task budget: retries draw the separate budget only', () => {
    const taskBudget = { spentUsd: 0.5 };
    const ledger = createRetryLedger({ maxAttempts: 3, maxCostUsd: 1 });
    // Fault injection: 5 consecutive provider flakes against a 3-attempt cap.
    let charged = 0;
    for (let attempt = 0; attempt < 5 && canRetry(ledger); attempt += 1) {
      chargeRetry(ledger, 0.2);
      charged += 1;
    }
    expect(charged).toBe(3);
    expect(canRetry(ledger)).toBe(false);
    expect(taskBudget.spentUsd).toBeCloseTo(0.5);
    expect(ledger.spentUsd).toBeCloseTo(0.6);
  });

  it('blocks retries once the retry cost cap is reached', () => {
    const ledger = createRetryLedger({ maxAttempts: 10, maxCostUsd: 0.5 });
    chargeRetry(ledger, 0.3);
    chargeRetry(ledger, 0.2);
    expect(canRetry(ledger)).toBe(false);
  });

  it('rejects negative retry charges: the ledger never goes backwards', () => {
    const ledger = createRetryLedger({ maxAttempts: 3, maxCostUsd: 1 });
    expect(() => chargeRetry(ledger, -0.1)).toThrow(/finite non-negative/);
    expect(ledger.attempts).toBe(0);
    expect(ledger.spentUsd).toBe(0);
    expect(canRetry(ledger)).toBe(true);
  });

  it('rejects NaN retry charges: NaN never poisons the ledger', () => {
    const ledger = createRetryLedger({ maxAttempts: 3, maxCostUsd: 1 });
    expect(() => chargeRetry(ledger, Number.NaN)).toThrow(
      /finite non-negative/,
    );
    expect(ledger.attempts).toBe(0);
    expect(ledger.spentUsd).toBe(0);
    expect(canRetry(ledger)).toBe(true);
  });

  it('accepts a zero-cost retry charge', () => {
    const ledger = createRetryLedger({ maxAttempts: 3, maxCostUsd: 1 });
    chargeRetry(ledger, 0);
    expect(ledger.attempts).toBe(1);
    expect(ledger.spentUsd).toBe(0);
  });
});
