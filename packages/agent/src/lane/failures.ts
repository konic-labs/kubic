// Failure taxonomy + retry chooser.
// Dotted codes preserve the distinctions retries depend on: collapsing
// run_limit into model_failed (or denied into timed_out) produces
// retries that cannot succeed. The chooser maps a classified failure to
// one of the six retry strategies, escalation, or abandon — never a blind
// repeat. Retries are bounded by RetryBudget.

import type { ResultErrorKind } from './settle.js';

const FAILURE_CODES = [
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
  'run_limit',
  'approval_denied',
  'approval_timed_out',
] as const;

// Agent-lifecycle codes (agent_looping, agent_crashed,
// agent_completed_with_failure) belong to the worker lifecycle owner, which is
// the only layer that can tell a crash from a completed-with-failure. This
// taxonomy covers lane-execution failures.

export type FailureCode = (typeof FAILURE_CODES)[number];

const RETRY_STRATEGIES = [
  'retry_same',
  'retry_with_new_context',
  'retry_with_new_agent',
  'retry_with_stronger_model',
  'retry_with_different_tool',
  'retry_with_wider_capability',
] as const;

// Full retry strategy vocabulary. Emitted today: retry_same (executed by the
// harness's durable generation retry), retry_with_different_tool, and
// retry_with_new_context (compact-then-retry). Stronger model and new
// agent are DECIDED here and executed by their owners; wider capability only
// ever arises through an explicit approval, never from this chooser.

type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

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
      // The durable `model_error` reason is generic — it names
      // the generation task, not the failure's domain. When the detail
      // names a provider capacity/rate-limit refusal or a tool fault,
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
      // non-retryable provider code (the list is pinned equal in the
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
      // Overflow compacts first, then retries on the fresh
      // context (executed by the recovery, through runManualCompaction).
      // A polluted context still escalates: only the operator picks the
      // fresh agent after seeing the record.
      return {
        code: 'context_overflow',
        remedy: 'Context overflowed; compact first, then retry once.',
        strategy: 'retry_with_new_context',
      };
    }
    case 'limit': {
      return {
        code: 'run_limit',
        remedy:
          'A run limit stopped the run; raise --max-turns or --timeout, or narrow the task. Never retry.',
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
  // What retries have cost so far, reported by the caller (task spend never
  // counts — only retry spend lands on the retry budget). A recovery passes
  // its measured retry cost; absent, only the attempts arm binds.
  costUsd?: number;
}

export interface RetryDecision {
  decision: RetryDecisionKind;
  notBefore?: number;
  reason: string;
}

// Product-policy retry budget: an attempts arm and a cost arm, spent only
// by retries ({maxAttempts, maxCostUsd}).
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
