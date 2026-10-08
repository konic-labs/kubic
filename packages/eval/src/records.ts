// Eval records.
// Every stored result carries how it ran: model/thinking/worktree/
// generation, the record SIZE (smoke|standard|extended — an
// implementation-side classification, not a design term) and
// the DETERMINISM tier (recorded|deterministic|live). Records
// missing worktree, generation, size or determinism are rejected (never
// stored) — a result that cannot be attributed cannot be reproduced, and a
// reader must be able to tell how far to trust a comparison. Cost/latency/
// tokens reconcile against usage rows before a record is accepted.
import { type EvalCategory, isEvalCategory } from './categories.js';
import type { EvalSignals } from './signals.js';

// The record's size class (how much was run). Deliberately NOT called a
// tier: tiers are the determinism tiers below, and the two stay distinct.
const EVAL_SIZES = ['smoke', 'standard', 'extended'] as const;

export type EvalSize = (typeof EVAL_SIZES)[number];

export function isEvalSize(value: string): value is EvalSize {
  return (EVAL_SIZES as readonly string[]).includes(value);
}

// Determinism tiers, published with every result: recorded
// scores an existing trajectory without re-executing anything;
// deterministic re-executes pinned; live executes a model-backed suite.
const DETERMINISM_TIERS = ['recorded', 'deterministic', 'live'] as const;

export type EvalDeterminism = (typeof DETERMINISM_TIERS)[number];

function isEvalDeterminism(value: string): value is EvalDeterminism {
  return (DETERMINISM_TIERS as readonly string[]).includes(value);
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
  size: string;
  determinism: string;
  signals?: EvalSignals;
}

export interface EvalRecord extends EvalRecordInput {
  size: EvalSize;
  determinism: EvalDeterminism;
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

// Fail-closed gate: worktree/generation/size/determinism missing or
// malformed means the record is rejected, not stored — the caller must not persist
// `record` when `valid` is false (it is absent on that branch).
export function validateEvalRecord(input: unknown): RecordValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (!nonEmpty(candidate.suite)) errors.push('suite is required');
  if (!nonEmpty(candidate.caseId)) errors.push('caseId is required');
  if (
    typeof candidate.category !== 'string' ||
    !isEvalCategory(candidate.category)
  ) {
    errors.push('category is required: one of the eight benchmark categories');
  }
  if (!nonEmpty(candidate.model)) errors.push('model is required');
  if (!nonNegative(candidate.costUsd)) errors.push('costUsd is required');
  if (!nonNegative(candidate.tokens)) errors.push('tokens is required');
  if (!nonNegative(candidate.latencyMs)) errors.push('latencyMs is required');
  if (!nonNegative(candidate.toolCalls)) errors.push('toolCalls is required');
  if (candidate.thinking !== null && !nonEmpty(candidate.thinking)) {
    errors.push('thinking must be a string or null');
  }
  if (!nonEmpty(candidate.worktree)) {
    errors.push('worktree is required: record how the run executed');
  }
  if (
    typeof candidate.generation !== 'number' ||
    !Number.isInteger(candidate.generation) ||
    !(candidate.generation >= 0)
  ) {
    errors.push('generation is required: record which worker generation ran');
  }
  if (typeof candidate.size !== 'string' || !isEvalSize(candidate.size)) {
    errors.push(
      `size is required: one of ${EVAL_SIZES.join(', ')} — refusing to store an unsized record`,
    );
  }
  if (
    typeof candidate.determinism !== 'string' ||
    !isEvalDeterminism(candidate.determinism)
  ) {
    errors.push(
      `determinism is required: one of ${DETERMINISM_TIERS.join(', ')} — refusing to store a record whose comparisons cannot be trusted`,
    );
  }
  if (errors.length > 0) return { valid: false, errors };
  const complete = candidate as unknown as EvalRecordInput & {
    size: EvalSize;
    determinism: EvalDeterminism;
  };
  return {
    valid: true,
    record: {
      ...complete,
      size: complete.size,
      determinism: complete.determinism,
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

// Reconciliation: the record's tokens/cost/latency must agree with
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
