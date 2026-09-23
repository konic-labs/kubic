// DPO exporter (issue #54; design §74).
// Chat-format preference record over an eligible pair: the DPO builder
// delegates eligibility to buildPreferencePair, so env failures and
// cross-boundary runs can never reach a trainable DPO record —
// validation additionally refuses any record whose boundary is not
// within, even hand-crafted.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import {
  buildPreferencePair,
  type ExcludedPair,
  PAIR_SCHEMA,
  validatePreferencePair,
} from './preference.js';
import type { RlProvenance, TrajectoryFailureCode } from './types.js';

export const DPO_SCHEMA = 'dpo/1';

export interface DpoRecord {
  schema: typeof DPO_SCHEMA;
  prompt: string;
  chosen: string;
  rejected: string;
  provenance: { chosen: RlProvenance; rejected: RlProvenance };
  failureCategory: {
    chosen: TrajectoryFailureCode | null;
    rejected: TrajectoryFailureCode | null;
  };
  boundary: 'within';
}

export interface DpoBuild {
  record: DpoRecord | null;
  excluded: ExcludedPair | null;
}

export type DpoValidation =
  | { valid: true; record: DpoRecord }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildDpoRecord(
  chosenExport: TrajectoryExport,
  rejectedExport: TrajectoryExport,
): DpoBuild {
  const built = buildPreferencePair(chosenExport, rejectedExport);
  if (built.pair === null) {
    return { record: null, excluded: built.excluded };
  }
  const pair = built.pair;
  return {
    record: {
      schema: DPO_SCHEMA,
      prompt: pair.prompt,
      chosen: pair.chosen.completion,
      rejected: pair.rejected.completion,
      provenance: {
        chosen: pair.chosen.provenance,
        rejected: pair.rejected.provenance,
      },
      failureCategory: {
        chosen: pair.chosen.failureCategory,
        rejected: pair.rejected.failureCategory,
      },
      boundary: 'within',
    },
    excluded: null,
  };
}

export function validateDpoRecord(input: unknown): DpoValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['DPO record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== DPO_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(DPO_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (!nonEmpty(candidate.chosen)) errors.push('chosen is required');
  if (!nonEmpty(candidate.rejected)) errors.push('rejected is required');
  if (candidate.boundary !== 'within') {
    errors.push('boundary must be within: cross-boundary pairs never validate');
  }
  // Reuse the pair-shape checks by projecting back onto a pair record.
  const provenance = candidate.provenance as
    | Record<string, unknown>
    | undefined;
  const failureCategory = candidate.failureCategory as
    | Record<string, unknown>
    | undefined;
  const projected = {
    schema: PAIR_SCHEMA,
    prompt: candidate.prompt,
    boundary: candidate.boundary,
    chosen: {
      completion: candidate.chosen,
      provenance: provenance?.chosen,
      failureCategory: failureCategory?.chosen,
      verifier: { verdict: 'pass', tests: 'pass' },
      taskRef: 'ref',
      worktreeRef:
        (provenance?.chosen as RlProvenance | undefined)?.worktree ?? '',
      grantRef: 'ref',
    },
    rejected: {
      completion: candidate.rejected,
      provenance: provenance?.rejected,
      failureCategory: failureCategory?.rejected,
      verifier: { verdict: 'fail', tests: 'fail' },
      taskRef: 'ref',
      worktreeRef:
        (provenance?.rejected as RlProvenance | undefined)?.worktree ?? '',
      grantRef: 'ref',
    },
  };
  const pairCheck = validatePreferencePair(projected);
  if (!pairCheck.valid) errors.push(...pairCheck.errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as DpoRecord };
}
