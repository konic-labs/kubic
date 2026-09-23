// (5) retry discipline: bounded separate budget §53 (issue #56; §62 lever 5).
// Retries draw a bounded retry budget that is SEPARATE from the task
// budget: a flaky provider exhausts the retry ledger and stops, it can
// never eat task funds. Consumes the RetryBudget shape (§71) read-only —
// the ledger here never mutates a task budget. Pure, faux-only.

export interface RetryBudgetCap {
  maxAttempts: number;
  maxCostUsd: number;
}

export interface RetryLedger extends RetryBudgetCap {
  attempts: number;
  spentUsd: number;
}

export class RetryBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryBudgetError';
  }
}

export function createRetryLedger(cap: RetryBudgetCap): RetryLedger {
  if (!(cap.maxAttempts > 0) || !(cap.maxCostUsd > 0)) {
    throw new RetryBudgetError('retry budget caps must be positive numbers');
  }
  return {
    maxAttempts: cap.maxAttempts,
    maxCostUsd: cap.maxCostUsd,
    attempts: 0,
    spentUsd: 0,
  };
}

export function canRetry(ledger: RetryLedger): boolean {
  return (
    ledger.attempts < ledger.maxAttempts && ledger.spentUsd < ledger.maxCostUsd
  );
}

export function chargeRetry(ledger: RetryLedger, costUsd: number): void {
  if (!canRetry(ledger)) {
    throw new RetryBudgetError(
      'retry budget exhausted: refusing further retries',
    );
  }
  ledger.attempts += 1;
  ledger.spentUsd += costUsd;
}
