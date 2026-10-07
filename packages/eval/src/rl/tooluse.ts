// Tool-use exporter.
// One record per trajectory: the bounded action sequence with
// observation refs. Observation text is carried as recorded —
// bounded upstream by the trajectory truncation contract
// (MAX_OBSERVATION_BYTES with byte counts kept) — alongside the
// provenance, label, and reference-verifier verdict.
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

export const TOOLUSE_SCHEMA = 'tool-use/1';

export interface ToolUseStep {
  seq: number;
  tool: string;
  args: unknown;
  observationRef: number | null;
  output: string | null;
  truncated: boolean;
  bytesOriginal: number | null;
}

export interface ToolUseRecord {
  schema: typeof TOOLUSE_SCHEMA;
  prompt: string;
  steps: ToolUseStep[];
  provenance: RlProvenance;
  failureCategory: TrajectoryFailureCode | null;
  verifier: VerifierVerdict;
}

export type ToolUseValidation =
  | { valid: true; record: ToolUseRecord }
  | { valid: false; errors: string[]; record?: undefined };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildToolUseRecord(exported: TrajectoryExport): ToolUseRecord {
  const provenance = extractProvenance(exported);
  const label = requireFailureLabel(exported);
  if (!label.ok) {
    throw new RlProvenanceError(`tool-use refused: ${label.errors.join('; ')}`);
  }
  if (!nonEmpty(exported.prompt?.text)) {
    throw new RlProvenanceError('tool-use refused: prompt text is required');
  }
  const observations = new Map(
    (exported.observations ?? []).map((observation) => [
      observation.actionSeq,
      observation,
    ]),
  );
  const steps = (exported.actions ?? []).map((action) => {
    const observation = observations.get(action.seq) ?? null;
    return {
      seq: action.seq,
      tool: action.tool,
      args: action.args,
      observationRef: observation?.seq ?? null,
      output: observation?.output ?? null,
      truncated: observation?.truncated ?? false,
      bytesOriginal: observation?.bytesOriginal ?? null,
    };
  });
  return {
    schema: TOOLUSE_SCHEMA,
    prompt: exported.prompt.text,
    steps,
    provenance,
    failureCategory: label.category,
    verifier: referenceVerifier(exported),
  };
}

export function validateToolUseRecord(input: unknown): ToolUseValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['tool-use record must be an object'] };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schema !== TOOLUSE_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(TOOLUSE_SCHEMA)}`);
  }
  if (!nonEmpty(candidate.prompt)) errors.push('prompt is required');
  if (!Array.isArray(candidate.steps)) {
    errors.push('steps must be an array');
  } else {
    for (const [index, entry] of candidate.steps.entries()) {
      const prefix = `steps[${index}]`;
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      const step = entry as Record<string, unknown>;
      if (typeof step.seq !== 'number' || !Number.isInteger(step.seq)) {
        errors.push(`${prefix}.seq must be an integer`);
      }
      if (!nonEmpty(step.tool)) errors.push(`${prefix}.tool is required`);
    }
  }
  errors.push(...checkProvenance(candidate.provenance));
  errors.push(...checkFailureCategory(candidate));
  errors.push(...checkVerifier(candidate.verifier));
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as ToolUseRecord };
}
