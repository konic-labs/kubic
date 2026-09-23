// SFT exporter (issue #54; design §74).
// One supervised record per trajectory: prompt + completion with the
// embedded provenance, §52 category, and reference-verifier verdict.
// Fail-closed both ways: build throws on stripped input; validate
// returns errors (never warnings) for stripped wire records.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import {
  extractProvenance,
  isTrajectoryFailureCode,
  requireFailureLabel,
  RlProvenanceError,
  type RlProvenance,
  type TrajectoryFailureCode,
} from './types.js';
import { referenceVerifier, type VerifierVerdict } from './verifier.js';

export const SFT_SCHEMA = 'sft/1';

export interface SftRecord {
  schema: typeof SFT_SCHEMA;
  prompt: string;
  completion: string;
  provenance: RlProvenance;
  failureCategory: TrajectoryFailureCode | null;
  verifier: VerifierVerdict;
}

export type SftValidation =
  | { valid: true; record: SftRecord }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildSftRecord(exported: TrajectoryExport): SftRecord {
  const provenance = extractProvenance(exported);
  const label = requireFailureLabel(exported);
  if (!label.ok) {
    throw new RlProvenanceError(`SFT refused: ${label.errors.join('; ')}`);
  }
  if (!nonEmpty(exported.prompt?.text)) {
    throw new RlProvenanceError('SFT refused: prompt text is required');
  }
  if (!nonEmpty(exported.result?.summary)) {
    throw new RlProvenanceError('SFT refused: result summary is required');
  }
  return {
    schema: SFT_SCHEMA,
    prompt: exported.prompt.text,
    completion: exported.result.summary,
    provenance,
    failureCategory: label.category,
    verifier: referenceVerifier(exported),
  };
}

export function validateSftRecord(input: unknown): SftValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['SFT record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== SFT_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(SFT_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (!nonEmpty(candidate.completion)) errors.push('completion is required');
  errors.push(...checkProvenance(candidate.provenance));
  errors.push(...checkFailureCategory(candidate));
  errors.push(...checkVerifier(candidate.verifier));
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as SftRecord };
}

export function checkProvenance(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['provenance is required: proc/gen/worktree/model/base (§74)'];
  }
  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  const proc = candidate.proc;
  if (
    proc !== null &&
    (typeof proc !== 'number' || !Number.isInteger(proc))
  ) {
    errors.push('provenance.proc must be an integer or null');
  }
  if (
    typeof candidate.gen !== 'number' ||
    !Number.isInteger(candidate.gen) ||
    !(candidate.gen >= 0)
  ) {
    errors.push('provenance.gen is required');
  }
  if (!nonEmpty(candidate.worktree)) errors.push('provenance.worktree is required');
  if (!nonEmpty(candidate.model)) errors.push('provenance.model is required');
  if (!nonEmpty(candidate.base)) errors.push('provenance.base is required');
  return errors;
}

export function checkFailureCategory(
  candidate: Record<string, unknown>,
): string[] {
  if (!('failureCategory' in candidate)) {
    return ['failureCategory is required: embed the §52 category (§74)'];
  }
  const category = candidate.failureCategory;
  if (category === null) return [];
  if (typeof category !== 'string' || !isTrajectoryFailureCode(category)) {
    return [
      `unknown §52 failure category ${JSON.stringify(category)}`,
    ];
  }
  return [];
}

export function checkVerifier(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['verifier is required: wire the reference verifier (§74)'];
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.verdict !== 'pass' && candidate.verdict !== 'fail') {
    return ['verifier.verdict must be pass or fail'];
  }
  return [];
}
