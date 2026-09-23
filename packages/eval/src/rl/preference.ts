// Preference-pair builder + cross-boundary policy (issue #54; §74).
// A trainable pair needs three things: a verifier preference signal
// (chosen passes, rejected fails), no env failure on either side (env
// breakage is not a capability difference), and one boundary (same
// worktree + same capability grant). Anything else emits no pair — the
// refusal is a tagged exclusion record, so audits keep env failures out
// of capability training without losing the evidence.
// Read-only reuse: the transfer snapshot {taskId, worktree, grantRef}
// mirrors the agents TransferLogRecord shape without importing it;
// pairs carry refs only (#32 artifacts, #49 graph edges) — never
// transcripts or file contents.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import { checkFailureCategory, checkProvenance, checkVerifier } from './sft.js';
import {
  extractProvenance,
  isEnvFailure,
  type RlProvenance,
  RlProvenanceError,
  requireFailureLabel,
  type TrajectoryFailureCode,
} from './types.js';
import { referenceVerifier, type VerifierVerdict } from './verifier.js';

export const PAIR_SCHEMA = 'pair/1';

// Refs-only side: where the run happened and what it concluded —
// task/worktree/grant refs plus the bounded completion text, never the
// transcript (#32) and never embedded file contents.
export interface PreferenceSide {
  completion: string;
  provenance: RlProvenance;
  failureCategory: TrajectoryFailureCode | null;
  verifier: VerifierVerdict;
  taskRef: string;
  worktreeRef: string;
  grantRef: string | null;
}

export type PairBoundary = 'within';

export interface PreferencePair {
  schema: typeof PAIR_SCHEMA;
  prompt: string;
  chosen: PreferenceSide;
  rejected: PreferenceSide;
  boundary: PairBoundary;
}

export type ExclusionTag =
  | 'env-failure-excluded'
  | 'cross-boundary-excluded'
  | 'no-preference-signal-excluded';

export interface ExcludedPair {
  prompt: string;
  tag: ExclusionTag;
  reason: string;
  chosenCategory: TrajectoryFailureCode | null;
  rejectedCategory: TrajectoryFailureCode | null;
}

export interface PairBuild {
  pair: PreferencePair | null;
  excluded: ExcludedPair | null;
}

export type PairValidation =
  | { valid: true; record: PreferencePair }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildSide(exported: TrajectoryExport): PreferenceSide {
  const provenance = extractProvenance(exported);
  const label = requireFailureLabel(exported);
  if (!label.ok) {
    throw new RlProvenanceError(`pair refused: ${label.errors.join('; ')}`);
  }
  if (!nonEmpty(exported.result?.summary)) {
    throw new RlProvenanceError('pair refused: result summary is required');
  }
  return {
    completion: exported.result.summary,
    provenance,
    failureCategory: label.category,
    verifier: referenceVerifier(exported),
    taskRef: exported.task.taskId,
    worktreeRef: provenance.worktree,
    grantRef: exported.transfer?.grantRef ?? null,
  };
}

function sameBoundary(
  chosen: PreferenceSide,
  rejected: PreferenceSide,
): boolean {
  // Both refs must agree, and a grant must be present on both: a missing
  // grant cannot prove the same capability boundary, so it fails closed
  // to cross-boundary rather than guessing within.
  if (chosen.worktreeRef !== rejected.worktreeRef) return false;
  if (chosen.grantRef === null || rejected.grantRef === null) return false;
  return chosen.grantRef === rejected.grantRef;
}

export function buildPreferencePair(
  chosenExport: TrajectoryExport,
  rejectedExport: TrajectoryExport,
): PairBuild {
  if (!nonEmpty(chosenExport.prompt?.text)) {
    throw new RlProvenanceError('pair refused: prompt text is required');
  }
  const prompt = chosenExport.prompt.text;
  const chosen = buildSide(chosenExport);
  const rejected = buildSide(rejectedExport);
  const exclude = (tag: ExclusionTag, reason: string): PairBuild => ({
    pair: null,
    excluded: {
      prompt,
      tag,
      reason,
      chosenCategory: chosen.failureCategory,
      rejectedCategory: rejected.failureCategory,
    },
  });
  // Env failures carry no capability signal — either side excluded.
  if (
    isEnvFailure(chosen.failureCategory) ||
    isEnvFailure(rejected.failureCategory)
  ) {
    return exclude(
      'env-failure-excluded',
      `env failure (${chosen.failureCategory ?? 'none'} vs ${rejected.failureCategory ?? 'none'}) is not a capability difference — kept out of capability training`,
    );
  }
  // The verifier must actually prefer chosen over rejected.
  if (
    chosen.verifier.verdict !== 'pass' ||
    rejected.verifier.verdict !== 'fail'
  ) {
    return exclude(
      'no-preference-signal-excluded',
      `no verifier preference signal (chosen ${chosen.verifier.verdict} vs rejected ${rejected.verifier.verdict})`,
    );
  }
  // One boundary: the same worktree under the same capability grant.
  if (!sameBoundary(chosen, rejected)) {
    return exclude(
      'cross-boundary-excluded',
      `cross-boundary runs (${chosen.worktreeRef}/${chosen.grantRef} vs ${rejected.worktreeRef}/${rejected.grantRef}) never form a trainable pair`,
    );
  }
  return {
    pair: { schema: PAIR_SCHEMA, prompt, chosen, rejected, boundary: 'within' },
    excluded: null,
  };
}

function checkSide(
  value: unknown,
  prefix: string,
): { errors: string[]; side?: PreferenceSide } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errors: [`${prefix} must be an object`] };
  }
  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!nonEmpty(candidate.completion))
    errors.push(`${prefix}.completion is required`);
  for (const message of checkProvenance(candidate.provenance)) {
    errors.push(`${prefix}.${message}`);
  }
  for (const message of checkFailureCategory(candidate)) {
    errors.push(`${prefix}.${message}`);
  }
  for (const message of checkVerifier(candidate.verifier)) {
    errors.push(`${prefix}.${message}`);
  }
  if (!nonEmpty(candidate.taskRef))
    errors.push(`${prefix}.taskRef is required`);
  if (!nonEmpty(candidate.worktreeRef))
    errors.push(`${prefix}.worktreeRef is required`);
  if (candidate.grantRef !== null && !nonEmpty(candidate.grantRef)) {
    errors.push(`${prefix}.grantRef must be a grant ref or null`);
  }
  if (errors.length > 0) return { errors };
  return { errors, side: candidate as unknown as PreferenceSide };
}

export function validatePreferencePair(input: unknown): PairValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['preference pair must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== PAIR_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(PAIR_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (candidate.boundary !== 'within') {
    errors.push('boundary must be within: cross-boundary pairs never validate');
  }
  const chosen = checkSide(candidate.chosen, 'chosen');
  const rejected = checkSide(candidate.rejected, 'rejected');
  errors.push(...chosen.errors, ...rejected.errors);
  if (
    chosen.side !== undefined &&
    rejected.side !== undefined &&
    !sameBoundary(chosen.side, rejected.side)
  ) {
    errors.push('chosen and rejected cross a worktree/grant boundary');
  }
  // Mirror the build policy: env failures carry no capability signal and
  // the verifier must actually prefer chosen over rejected — hand-crafted
  // records bypass the builder, so validation re-enforces both.
  if (chosen.side !== undefined && rejected.side !== undefined) {
    if (
      isEnvFailure(chosen.side.failureCategory) ||
      isEnvFailure(rejected.side.failureCategory)
    ) {
      errors.push(
        'env failure runs carry no capability signal: excluded from capability training',
      );
    }
    if (
      chosen.side.verifier.verdict !== 'pass' ||
      rejected.side.verifier.verdict !== 'fail'
    ) {
      errors.push(
        `no verifier preference signal (chosen ${chosen.side.verifier.verdict} vs rejected ${rejected.side.verifier.verdict})`,
      );
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as PreferencePair };
}
