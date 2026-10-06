// §52 failure taxonomy + §53 retry chooser (issue #14, slice C).
// Dotted codes preserve the distinctions retries depend on: collapsing
// budget_exhausted into model_failed (or denied into timed_out) produces
// retries that cannot succeed. The chooser maps a classified failure to
// one of the six §53 strategies, escalation, or abandon — never a blind
// repeat. Retry spend lands on RetryBudget, never on the task budget.

import type { ResultErrorKind } from '../result.js';

export const FAILURE_CODES = [
  'model_failed',
  'model_refused',
  'provider_transient',
  'provider_auth',
  'tool_failed',
  'tool_invalid_args',
  'tool_timeout',
  'tool_unavailable',
  'process_crashed',
  'process_spawn_failed',
  'workspace_failed',
  'context_overflow',
  'context_polluted',
  'budget_exhausted',
  'approval_denied',
  'approval_timed_out',
] as const;

// Agent-lifecycle codes (agent_looping, agent_crashed,
// agent_completed_with_failure) belong to the worker lifecycle owner
// (issue #42), which is the only layer that can tell a crash from a
// completed-with-failure. This taxonomy covers lane-execution failures.

export type FailureCode = (typeof FAILURE_CODES)[number];

export function isFailureCode(value: unknown): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value as string);
}

export const RETRY_STRATEGIES = [
  'retry_same',
  'retry_with_new_context',
  'retry_with_new_agent',
  'retry_with_stronger_model',
  'retry_with_different_tool',
  'retry_with_wider_capability',
] as const;

// Full §53 strategy vocabulary. Emitted today: retry_same (executed by the
// harness's durable generation retry, #395), retry_with_different_tool, and
// retry_with_new_context (solo compact-then-retry, issue #209). Stronger
// model and new agent are DECIDED here and executed by their owners
// (#210 escalates, #184 relaunches with a handoff); wider capability only
// ever arises through an explicit approval (#16), never from this chooser.

export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

export type RetryDecisionKind = RetryStrategy | 'escalate' | 'abandon';

export interface ClassifiedFailure {
  code: FailureCode;
  remedy: string;
  strategy: RetryDecisionKind;
}

export function classifyFailure(
  kind: ResultErrorKind,
  code: string,
  message: string,
): ClassifiedFailure {
  const haystack = `${code} ${message}`.toLowerCase();
  switch (kind) {
    case 'model': {
      // Issue #155: the durable `model_error` reason is generic — it names
      // the generation task, not the failure's domain. When the detail
      // names a provider capacity/rate-limit refusal or a tool fault, §52
      // keeps that distinction instead of collapsing it into model_failed.
      if (
        /rate ?limit|too many requests|\b429\b|overloaded|at capacity|capacity exhausted|quota/i.test(
          haystack,
        )
      ) {
        return {
          code: 'provider_transient',
          remedy:
            'Provider capacity/rate limit; retry unchanged after notBefore.',
          strategy: 'retry_same',
        };
      }
      if (/\btool\b[^.]*(fail|fault|error|crash)/i.test(haystack)) {
        return {
          code: 'tool_failed',
          remedy:
            'Tool execution failed; inspect stderr, then retry or switch tools.',
          strategy: 'retry_same',
        };
      }
      if (/refus/.test(haystack)) {
        return {
          code: 'model_refused',
          remedy:
            'The model refused the task; reframe the objective or escalate to the user.',
          strategy: 'escalate',
        };
      }
      return {
        code: 'model_failed',
        remedy:
          'Inspect the model error; transient model errors retry unchanged.',
        strategy: 'retry_same',
      };
    }
    case 'provider': {
      // No provider/model configured is a setup failure, not a transient
      // one: retrying unchanged can never succeed. It rides the existing
      // non-retryable provider code (the §52 list is pinned equal in the
      // trajectory/eval schemas) with a remedy that names the real fix.
      if (
        /no models? available|register a provider|no providers? (?:configured|registered)|provider not configured|no model configured/.test(
          haystack,
        )
      ) {
        return {
          code: 'provider_auth',
          remedy:
            'No provider/model is configured; register a provider (kubic models) or set KUBIC_MODEL, then rerun.',
          strategy: 'abandon',
        };
      }
      if (
        /auth|denied|unauthorized|forbidden|invalid key|api key/.test(haystack)
      ) {
        return {
          code: 'provider_auth',
          remedy: 'Fix provider credentials, then retry.',
          strategy: 'abandon',
        };
      }
      return {
        code: 'provider_transient',
        remedy: 'Transient provider error; retry unchanged after notBefore.',
        strategy: 'retry_same',
      };
    }
    case 'tool': {
      if (
        /invalid (args|arguments)|validation|unknown key|unexpected key/.test(
          haystack,
        )
      ) {
        return {
          code: 'tool_invalid_args',
          remedy:
            'The model must fix the arguments; retry lets it correct itself.',
          strategy: 'retry_same',
        };
      }
      if (/timeout|timed out/.test(haystack)) {
        return {
          code: 'tool_timeout',
          remedy: 'Tool timed out; retry unchanged with a longer timeout.',
          strategy: 'retry_same',
        };
      }
      if (/unknown_tool|not found|unavailable|no such tool/.test(haystack)) {
        return {
          code: 'tool_unavailable',
          remedy: 'The tool is unavailable; retry with a different tool.',
          strategy: 'retry_with_different_tool',
        };
      }
      return {
        code: 'tool_failed',
        remedy:
          'Tool execution failed; inspect stderr, then retry or switch tools.',
        strategy: 'retry_same',
      };
    }
    case 'process': {
      if (/spawn|enoent|eacces|eperm/.test(haystack)) {
        return {
          code: 'process_spawn_failed',
          remedy: 'The process never started; fix the environment, then retry.',
          strategy: 'retry_same',
        };
      }
      return {
        code: 'process_crashed',
        remedy:
          'The process crashed mid-run; retry unchanged from the checkpoint.',
        strategy: 'retry_same',
      };
    }
    case 'workspace': {
      return {
        code: 'workspace_failed',
        remedy:
          'Workspace failure (worktree, merge, disk); needs human attention.',
        strategy: 'escalate',
      };
    }
    case 'context': {
      if (/pollut/.test(haystack)) {
        return {
          code: 'context_polluted',
          remedy:
            'Context is polluted; escalate with the record. The follow-up retry_with_new_agent is chosen by the operator after escalation, not spent here.',
          strategy: 'escalate',
        };
      }
      // Issue #209: overflow compacts first, then retries on the fresh
      // context (executed by the solo recovery, #399's compactSoloLane).
      // A polluted context still escalates: only the operator picks the
      // fresh agent after seeing the record.
      return {
        code: 'context_overflow',
        remedy: 'Context overflowed; compact first, then retry once.',
        strategy: 'retry_with_new_context',
      };
    }
    case 'budget': {
      return {
        code: 'budget_exhausted',
        remedy:
          'Budget exhausted; raise the budget or narrow the task. Never retry.',
        strategy: 'abandon',
      };
    }
    case 'approval': {
      if (/denied|reject/.test(haystack)) {
        return {
          code: 'approval_denied',
          remedy:
            'The user denied the action; do not retry without a new proposal.',
          strategy: 'abandon',
        };
      }
      return {
        code: 'approval_timed_out',
        remedy: 'Approval timed out; escalate for human attention.',
        strategy: 'escalate',
      };
    }
  }
}

export interface RetryHints {
  retryAfterMs?: number;
  now?: number;
  // Retry spend metered OUTSIDE this budget (issue #209): the caller
  // reports what retries have cost so far (task spend never counts —
  // retry spend lands on the retry budget, §53). The orchestrator passes
  // its BudgetUsage; a solo recovery passes its measured retry cost.
  // Absent, only the attempts arm binds.
  costUsd?: number;
}

// §52 code → the ResultErrorKind it belongs to (issue #155): the inverse of
// the classifier, for consumers that only see a code (a worker's own
// report) and must still name the failure's domain.
const KIND_BY_FAILURE_CODE: Readonly<Record<FailureCode, ResultErrorKind>> = {
  model_failed: 'model',
  model_refused: 'model',
  provider_transient: 'provider',
  provider_auth: 'provider',
  tool_failed: 'tool',
  tool_invalid_args: 'tool',
  tool_timeout: 'tool',
  tool_unavailable: 'tool',
  process_crashed: 'process',
  process_spawn_failed: 'process',
  workspace_failed: 'workspace',
  context_overflow: 'context',
  context_polluted: 'context',
  budget_exhausted: 'budget',
  approval_denied: 'approval',
  approval_timed_out: 'approval',
};

export function errorKindForFailureCode(code: FailureCode): ResultErrorKind {
  return KIND_BY_FAILURE_CODE[code];
}

export interface RetryDecision {
  decision: RetryDecisionKind;
  notBefore?: number;
  reason: string;
}

// Product-policy retry budget (issue #209): attempts AND cost arms, spent
// separately from any task budget. Constructed from the orchestrator's
// RetryBudgetConfig ({maxAttempts, maxCostUsd}) wherever a retry policy
// runs — same field names, no import (the lane never imports host).
export class RetryBudget {
  private spent = 0;
  readonly maxAttempts: number;
  readonly maxCostUsd: number;

  constructor(maxAttempts: number, maxCostUsd = Number.POSITIVE_INFINITY) {
    this.maxAttempts = maxAttempts;
    this.maxCostUsd = maxCostUsd;
  }

  get remaining(): number {
    return Math.max(0, this.maxAttempts - this.spent);
  }

  decide(strategy: RetryDecisionKind, hints: RetryHints = {}): RetryDecision {
    if (strategy === 'abandon' || strategy === 'escalate') {
      return {
        decision: strategy,
        reason: `${strategy} (no retry spend)`,
      };
    }
    if (this.spent >= this.maxAttempts) {
      return {
        decision: 'abandon',
        reason: `retry budget exhausted (${this.spent}/${this.maxAttempts} attempts)`,
      };
    }
    const spend = hints.costUsd ?? 0;
    if (spend >= this.maxCostUsd) {
      return {
        decision: 'abandon',
        reason: `retry budget exhausted ($${spend}/$${this.maxCostUsd} retry spend)`,
      };
    }
    this.spent += 1;
    const now = hints.now ?? Date.now();
    const delay = Math.max(0, hints.retryAfterMs ?? 0);
    return {
      decision: strategy,
      notBefore: now + delay,
      reason: `retry ${this.spent}/${this.maxAttempts} (${strategy})`,
    };
  }
}

export function chooseRetry(
  failure: ClassifiedFailure,
  hints: RetryHints,
  budget: RetryBudget,
): RetryDecision {
  return budget.decide(failure.strategy, hints);
}
