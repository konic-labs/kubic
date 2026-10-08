// Coding exporter.
// One record per trajectory: prompt + completion with diff refs and the
// reference-verifier verdict. Refs only: diffRefs are changed
// paths, hunkCounts are per-file hunk counts — hunk contents and file
// contents never enter the record.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import { checkFailureCategory, checkProvenance, checkVerifier } from './sft.js';
import {
  extractProvenance,
  type RlProvenance,
  RlProvenanceError,
  requireFailureLabel,
  type TrajectoryFailureCode,
} from './types.js';
import { referenceVerifier, type VerifierVerdict } from './verifier.js';

const CODING_SCHEMA = 'coding/1';

export interface CodingRecord {
  schema: typeof CODING_SCHEMA;
  prompt: string;
  completion: string;
  diffRefs: string[];
  hunkCounts: Record<string, number>;
  provenance: RlProvenance;
  failureCategory: TrajectoryFailureCode | null;
  verifier: VerifierVerdict;
}

export type CodingValidation =
  | { valid: true; record: CodingRecord }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildCodingRecord(exported: TrajectoryExport): CodingRecord {
  const provenance = extractProvenance(exported);
  const label = requireFailureLabel(exported);
  if (!label.ok) {
    throw new RlProvenanceError(`coding refused: ${label.errors.join('; ')}`);
  }
  if (!nonEmpty(exported.prompt?.text)) {
    throw new RlProvenanceError('coding refused: prompt text is required');
  }
  if (!nonEmpty(exported.result?.summary)) {
    throw new RlProvenanceError('coding refused: result summary is required');
  }
  const hunkCounts: Record<string, number> = {};
  for (const file of exported.diff?.files ?? []) {
    hunkCounts[file.path] = file.hunks.length;
  }
  return {
    schema: CODING_SCHEMA,
    prompt: exported.prompt.text,
    completion: exported.result.summary,
    diffRefs: [...(exported.diff?.filesChanged ?? [])],
    hunkCounts,
    provenance,
    failureCategory: label.category,
    verifier: referenceVerifier(exported),
  };
}

export function validateCodingRecord(input: unknown): CodingValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['coding record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== CODING_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(CODING_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (!nonEmpty(candidate.completion)) errors.push('completion is required');
  if (
    !Array.isArray(candidate.diffRefs) ||
    !candidate.diffRefs.every((ref) => nonEmpty(ref))
  ) {
    errors.push('diffRefs must be an array of changed paths');
  }
  if (
    typeof candidate.hunkCounts !== 'object' ||
    candidate.hunkCounts === null ||
    Array.isArray(candidate.hunkCounts)
  ) {
    errors.push('hunkCounts must be an object');
  }
  errors.push(...checkProvenance(candidate.provenance));
  errors.push(...checkFailureCategory(candidate));
  errors.push(...checkVerifier(candidate.verifier));
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as CodingRecord };
}
