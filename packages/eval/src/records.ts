// Eval records (issue #53; design §48, §72, §73).
// Every stored result carries how it ran: model/thinking/worktree/
// generation/tier. Records missing worktree, generation, or tier are
// rejected (never stored) — a result that cannot be attributed to a
// worktree + generation + tier cannot be reproduced. Cost/latency/tokens
// reconcile against §39 usage rows before a record is accepted.
import type { EvalCategory } from './categories.js';
import type { EvalSignals } from './signals.js';

export const EVAL_TIERS = ['smoke', 'standard', 'extended'] as const;

export type EvalTier = (typeof EVAL_TIERS)[number];

export function isEvalTier(value: string): value is EvalTier {
  return (EVAL_TIERS as readonly string[]).includes(value);
}

export interface EvalRecordInput {
  suite: string;
  caseId: string;
  category: EvalCategory;
  success: boolean;
  costUsd: number;
  tokens: number;
  latencyMs: number;
  toolCalls: number;
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number;
  tier: string;
  signals?: EvalSignals;
}

export interface EvalRecord extends EvalRecordInput {
  tier: EvalTier;
  recordedAt: string;
}

export type RecordValidation =
  | { valid: true; record: EvalRecord }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && value >= 0;
}

// Fail-closed gate: worktree/generation/tier missing or malformed means
// the record is rejected, not stored — the caller must not persist
// `record` when `valid` is false (it is absent on that branch).
export function validateEvalRecord(input: unknown): RecordValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (!nonEmpty(candidate.suite)) errors.push('suite is required');
  if (!nonEmpty(candidate.caseId)) errors.push('caseId is required');
  if (!nonEmpty(candidate.model)) errors.push('model is required');
  if (!nonNegative(candidate.costUsd)) errors.push('costUsd is required');
  if (!nonNegative(candidate.tokens)) errors.push('tokens is required');
  if (!nonNegative(candidate.latencyMs)) errors.push('latencyMs is required');
  if (!nonNegative(candidate.toolCalls)) errors.push('toolCalls is required');
  if (candidate.thinking !== null && !nonEmpty(candidate.thinking)) {
    errors.push('thinking must be a string or null');
  }
  if (!nonEmpty(candidate.worktree)) {
    errors.push('worktree is required: record how the run executed (§73)');
  }
  if (
    typeof candidate.generation !== 'number' ||
    !(candidate.generation >= 0)
  ) {
    errors.push(
      'generation is required: record which worker generation ran (§73)',
    );
  }
  if (typeof candidate.tier !== 'string' || !isEvalTier(candidate.tier)) {
    errors.push(
      `tier is required: one of ${EVAL_TIERS.join(', ')} (§72) — refusing to store an untiered record`,
    );
  }
  if (errors.length > 0) return { valid: false, errors };
  const complete = candidate as unknown as EvalRecordInput & {
    tier: EvalTier;
  };
  return {
    valid: true,
    record: {
      ...complete,
      tier: complete.tier,
      recordedAt: new Date().toISOString(),
    },
  };
}

export interface UsageRowLike {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs?: number;
}

export interface ReconcileResult {
  ok: boolean;
  errors: string[];
}

// §39 reconciliation: the record's tokens/cost/latency must agree with
// the summed usage rows. Exact on tokens; cost within a cent fraction;
// latency must cover the summed row latency (the run cannot be faster
// than its measured requests).
export function reconcileUsage(
  record: Pick<EvalRecordInput, 'tokens' | 'costUsd' | 'latencyMs'>,
  rows: UsageRowLike[],
): ReconcileResult {
  const errors: string[] = [];
  let tokens = 0;
  let cost = 0;
  let latency = 0;
  for (const row of rows) {
    tokens += row.inputTokens + row.outputTokens;
    cost += row.costUsd;
    latency += row.latencyMs ?? 0;
  }
  if (tokens !== record.tokens) {
    errors.push(
      `tokens mismatch: record ${record.tokens} vs usage rows ${tokens}`,
    );
  }
  if (Math.abs(cost - record.costUsd) > 1e-9) {
    errors.push(
      `cost mismatch: record ${record.costUsd} vs usage rows ${cost}`,
    );
  }
  if (latency > record.latencyMs) {
    errors.push(
      `latency mismatch: record ${record.latencyMs}ms is less than summed usage ${latency}ms`,
    );
  }
  return { ok: errors.length === 0, errors };
}
