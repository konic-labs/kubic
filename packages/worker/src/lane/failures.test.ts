// Slice C: §52 failure taxonomy + §53 retry chooser (issue #14).
import { describe, expect, it } from 'vitest';
import { chooseRetry, classifyFailure, RetryBudget } from './failures.js';

describe('failure taxonomy (issue #14, slice C)', () => {
  it('preserves the §52 distinctions', () => {
    expect(classifyFailure('process', 'spawn ENOENT', '').code).toBe(
      'process_spawn_failed',
    );
    expect(classifyFailure('process', 'crashed signal 9', '').code).toBe(
      'process_crashed',
    );
    expect(classifyFailure('tool', 'exit 1', '').code).toBe('tool_failed');
    expect(classifyFailure('budget', 'tokens exhausted', '').code).toBe(
      'budget_exhausted',
    );
    expect(classifyFailure('model', 'tokens exhausted', '').code).toBe(
      'model_failed',
    );
    expect(classifyFailure('approval', 'denied by user', '').code).toBe(
      'approval_denied',
    );
    expect(classifyFailure('approval', 'timed out', '').code).toBe(
      'approval_timed_out',
    );
  });

  it('gives every code a remedy', () => {
    for (const kind of [
      'model',
      'provider',
      'tool',
      'process',
      'workspace',
      'context',
      'budget',
      'approval',
    ] as const) {
      const failure = classifyFailure(kind, 'something broke', '');
      expect(failure.remedy.length).toBeGreaterThan(0);
      expect(failure.strategy.length).toBeGreaterThan(0);
    }
  });

  it('routes transient provider errors to retry_same with notBefore', () => {
    const failure = classifyFailure('provider', '429 rate limited', '');
    const decision = chooseRetry(
      failure,
      { retryAfterMs: 5000, now: 1_000 },
      new RetryBudget(3),
    );
    expect(decision.decision).toBe('retry_same');
    expect(decision.notBefore).toBe(6_000);
  });

  it('routes polluted context to escalation, not blind retry', () => {
    const failure = classifyFailure('context', 'context polluted', '');
    const budget = new RetryBudget(3);
    const decision = chooseRetry(failure, {}, budget);
    expect(decision.decision).toBe('escalate');
    // Escalation is not a retry: it spends nothing from the retry budget.
    expect(budget.remaining).toBe(3);
  });

  it('abandons on budget exhaustion and denied approvals', () => {
    const budget = chooseRetry(
      classifyFailure('budget', 'spent', ''),
      {},
      new RetryBudget(3),
    );
    expect(budget.decision).toBe('abandon');
    const denied = chooseRetry(
      classifyFailure('approval', 'denied', ''),
      {},
      new RetryBudget(3),
    );
    expect(denied.decision).toBe('abandon');
  });

  it('spends retry budget separately from task budget', () => {
    const retries = new RetryBudget(1);
    const failure = classifyFailure('provider', '500 upstream', '');
    const first = chooseRetry(failure, {}, retries);
    expect(first.decision).toBe('retry_same');
    const second = chooseRetry(failure, {}, retries);
    expect(second.decision).toBe('abandon');
    expect(second.reason).toContain('retry budget');
  });
});

describe('provider not configured is never transient', () => {
  it('classifies "no models available" as a non-retryable provider failure', () => {
    const out = classifyFailure(
      'provider',
      'exited_6',
      'no models available: register a provider first',
    );
    expect(out.code).not.toBe('provider_transient');
    expect(out.code).toBe('provider_auth');
    expect(out.strategy).toBe('abandon');
    expect(out.remedy).toMatch(/configure|register/i);
  });
});

describe('a missing provider response stays transient', () => {
  it('keeps "no provider response" retryable', () => {
    const out = classifyFailure(
      'provider',
      'exited_6',
      'no provider response (503)',
    );
    expect(out.code).toBe('provider_transient');
  });
});

// Issue #155: the durable `model_error` reason names the generation task,
// not the failure's domain. A detail that names a provider rate-limit
// refusal or a tool fault keeps its own §52 code instead of collapsing
// into model_failed.
describe('generic model errors keep the detail domain (issue #155)', () => {
  it('classifies a provider rate-limit detail as provider_transient', () => {
    const out = classifyFailure(
      'model',
      'model_error',
      'api rate limit exceeded (429)',
    );
    expect(out.code).toBe('provider_transient');
    expect(out.strategy).toBe('retry_same');
    expect(out.remedy).toMatch(/retry/i);
  });

  it('classifies a tool fault detail as tool_failed', () => {
    const out = classifyFailure(
      'model',
      'model_error',
      "tool 'read' failed: ENOENT",
    );
    expect(out.code).toBe('tool_failed');
  });

  it('keeps a plain model detail model_failed (the #395 pin)', () => {
    expect(
      classifyFailure('model', 'model_error', 'provider returned 500').code,
    ).toBe('model_failed');
    expect(
      classifyFailure('model', 'model_error', 'the model produced nothing')
        .code,
    ).toBe('model_failed');
  });
});

describe('retry budget attempts and cost (issue #209)', () => {
  it('abandons the third failure with maxAttempts=2, naming the retry budget', () => {
    const retries = new RetryBudget(2);
    const failure = classifyFailure('provider', '500 upstream', '');
    expect(chooseRetry(failure, {}, retries).decision).toBe('retry_same');
    expect(chooseRetry(failure, {}, retries).decision).toBe('retry_same');
    const third = chooseRetry(failure, {}, retries);
    expect(third.decision).toBe('abandon');
    expect(third.reason).toContain('retry budget');
  });

  it('abandons when reported retry spend reaches maxCostUsd', () => {
    const retries = new RetryBudget(10, 1);
    const failure = classifyFailure('provider', '500 upstream', '');
    const first = chooseRetry(failure, { costUsd: 0.4 }, retries);
    expect(first.decision).toBe('retry_same');
    const second = chooseRetry(failure, { costUsd: 1.0 }, retries);
    expect(second.decision).toBe('abandon');
    expect(second.reason).toContain('retry budget');
  });

  it('never spends budget on abandon or escalate', () => {
    const retries = new RetryBudget(1);
    const denied = classifyFailure('approval', 'denied', 'user denied');
    expect(chooseRetry(denied, {}, retries).decision).toBe('abandon');
    const polluted = classifyFailure('context', 'polluted', 'polluted context');
    expect(chooseRetry(polluted, {}, retries).decision).toBe('escalate');
    // The single attempt is still available: nothing was spent above.
    const transient = classifyFailure('provider', '500 upstream', '');
    expect(chooseRetry(transient, {}, retries).decision).toBe('retry_same');
  });

  it('routes context overflow to compact-then-retry, not escalation', () => {
    const out = classifyFailure(
      'context',
      'context_overflow',
      'too many tokens',
    );
    expect(out.code).toBe('context_overflow');
    expect(out.strategy).toBe('retry_with_new_context');
  });
});
