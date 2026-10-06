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

  // Remedy table keyed by code (issue #219): every branch names its exact
  // code, remedy and strategy — a wrong mapping fails here, not in a
  // trajectory review.
  it.each([
    [
      'model',
      '429 rate limited',
      'provider_transient',
      'Provider capacity/rate limit; retry unchanged after notBefore.',
      'retry_same',
    ],
    [
      'model',
      'tool crashed',
      'tool_failed',
      'Tool execution failed; inspect stderr, then retry or switch tools.',
      'retry_same',
    ],
    [
      'model',
      'refused',
      'model_refused',
      'The model refused the task; reframe the objective or escalate to the user.',
      'escalate',
    ],
    [
      'model',
      'weird boom',
      'model_failed',
      'Inspect the model error; transient model errors retry unchanged.',
      'retry_same',
    ],
    [
      'provider',
      'no models available',
      'provider_auth',
      'No provider/model is configured; register a provider (kubic models) or set KUBIC_MODEL, then rerun.',
      'abandon',
    ],
    [
      'provider',
      'invalid key',
      'provider_auth',
      'Fix provider credentials, then retry.',
      'abandon',
    ],
    [
      'provider',
      'socket hang up',
      'provider_transient',
      'Transient provider error; retry unchanged after notBefore.',
      'retry_same',
    ],
    [
      'tool',
      'invalid arguments',
      'tool_invalid_args',
      'The model must fix the arguments; retry lets it correct itself.',
      'retry_same',
    ],
    [
      'tool',
      'timed out',
      'tool_timeout',
      'Tool timed out; retry unchanged with a longer timeout.',
      'retry_same',
    ],
    [
      'tool',
      'unknown_tool',
      'tool_unavailable',
      'The tool is unavailable; retry with a different tool.',
      'retry_with_different_tool',
    ],
    [
      'tool',
      'boom',
      'tool_failed',
      'Tool execution failed; inspect stderr, then retry or switch tools.',
      'retry_same',
    ],
    [
      'process',
      'spawn ENOENT',
      'process_spawn_failed',
      'The process never started; fix the environment, then retry.',
      'retry_same',
    ],
    [
      'process',
      'segfault',
      'process_crashed',
      'The process crashed mid-run; retry unchanged from the checkpoint.',
      'retry_same',
    ],
    [
      'workspace',
      'disk full',
      'workspace_failed',
      'Workspace failure (worktree, merge, disk); needs human attention.',
      'escalate',
    ],
    [
      'context',
      'context polluted',
      'context_polluted',
      'Context is polluted; escalate with the record. The follow-up retry_with_new_agent is chosen by the operator after escalation, not spent here.',
      'escalate',
    ],
    [
      'context',
      'overflow',
      'context_overflow',
      'Context overflowed; compact first, then retry once.',
      'retry_with_new_context',
    ],
    [
      'budget',
      'spent',
      'budget_exhausted',
      'Budget exhausted; raise the budget or narrow the task. Never retry.',
      'abandon',
    ],
    [
      'approval',
      'denied by user',
      'approval_denied',
      'The user denied the action; do not retry without a new proposal.',
      'abandon',
    ],
    [
      'approval',
      'timed out',
      'approval_timed_out',
      'Approval timed out; escalate for human attention.',
      'escalate',
    ],
  ] as const)(
    '%s / %s classifies exactly',
    (kind, code, expectedCode, expectedRemedy, expectedStrategy) => {
      expect(classifyFailure(kind, code, '')).toEqual({
        code: expectedCode,
        remedy: expectedRemedy,
        strategy: expectedStrategy,
      });
    },
  );

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
