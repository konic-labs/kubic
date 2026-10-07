// GRPO exporter.
// One group per prompt: candidate completions with reference-verifier
// rewards (pass → 1, fail → 0). Candidates keep their own provenance +
// Label + prompt copy so the group validates even shuffled; the
// group prompt must equal every candidate prompt.
import type { TrajectoryExport } from '../../../trajectory/src/schema.js';
import {
  checkFailureCategory,
  checkProvenance,
  checkVerifier,
  SFT_SCHEMA,
} from './sft.js';
import {
  extractProvenance,
  type RlProvenance,
  RlProvenanceError,
  requireFailureLabel,
  type TrajectoryFailureCode,
} from './types.js';
import { referenceVerifier, type VerifierVerdict } from './verifier.js';

export const GRPO_SCHEMA = 'grpo/1';

export interface GrpoCandidate {
  prompt: string;
  completion: string;
  reward: number;
  provenance: RlProvenance;
  failureCategory: TrajectoryFailureCode | null;
  verifier: VerifierVerdict;
}

export interface GrpoGroup {
  schema: typeof GRPO_SCHEMA;
  prompt: string;
  candidates: GrpoCandidate[];
}

export type GrpoValidation =
  | { valid: true; record: GrpoGroup }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildCandidate(exported: TrajectoryExport): GrpoCandidate {
  const provenance = extractProvenance(exported);
  const label = requireFailureLabel(exported);
  if (!label.ok) {
    throw new RlProvenanceError(`GRPO refused: ${label.errors.join('; ')}`);
  }
  if (!nonEmpty(exported.prompt?.text)) {
    throw new RlProvenanceError('GRPO refused: prompt text is required');
  }
  if (!nonEmpty(exported.result?.summary)) {
    throw new RlProvenanceError('GRPO refused: result summary is required');
  }
  const verifier = referenceVerifier(exported);
  return {
    prompt: exported.prompt.text,
    completion: exported.result.summary,
    reward: verifier.verdict === 'pass' ? 1 : 0,
    provenance,
    failureCategory: label.category,
    verifier,
  };
}

// A GRPO group compares several answers to ONE prompt: a group of
// one has no relative signal, and a candidate answering another prompt or
// task corrupts the group's baseline — both are refused, never emitted.
export function buildGrpoGroup(exports: TrajectoryExport[]): GrpoGroup {
  if (exports.length < 2) {
    throw new RlProvenanceError(
      `GRPO refused: a group needs at least two candidates (got ${exports.length})`,
    );
  }
  const candidates = exports.map(buildCandidate);
  const first = exports[0] as TrajectoryExport;
  for (const [index, exported] of exports.entries()) {
    if (
      exported.prompt.text !== first.prompt.text ||
      exported.task?.taskId !== first.task?.taskId
    ) {
      throw new RlProvenanceError(
        `GRPO refused: candidate ${index} answers a different prompt or task than candidate 0`,
      );
    }
  }
  const prompt = first.prompt.text;
  return { schema: GRPO_SCHEMA, prompt, candidates };
}

export function validateGrpoGroup(input: unknown): GrpoValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['GRPO group must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== GRPO_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(GRPO_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (!Array.isArray(candidate.candidates) || candidate.candidates.length < 2) {
    return {
      valid: false,
      errors: [...errors, 'candidates must hold at least two records'],
    };
  }
  const group = candidate as unknown as GrpoGroup;
  for (const [index, entry] of group.candidates.entries()) {
    const prefix = `candidates[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const record = entry as unknown as Record<string, unknown> & {
      schema?: unknown;
    };
    if (record.schema !== undefined && record.schema !== SFT_SCHEMA) {
      errors.push(
        `${prefix}.schema must be ${JSON.stringify(SFT_SCHEMA)} when present`,
      );
    }
    if (!nonEmpty(record.prompt)) errors.push(`${prefix}.prompt is required`);
    else if (record.prompt !== group.prompt) {
      errors.push(`${prefix} shares no prompt with the group`);
    }
    if (!nonEmpty(record.completion))
      errors.push(`${prefix}.completion is required`);
    if (
      typeof record.reward !== 'number' ||
      !(record.reward >= 0) ||
      !(record.reward <= 1)
    ) {
      errors.push(`${prefix}.reward must be a number in [0, 1]`);
    }
    for (const message of checkProvenance(record.provenance)) {
      errors.push(`${prefix}.${message}`);
    }
    for (const message of checkFailureCategory(record)) {
      errors.push(`${prefix}.${message}`);
    }
    for (const message of checkVerifier(record.verifier)) {
      errors.push(`${prefix}.${message}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: group };
}
