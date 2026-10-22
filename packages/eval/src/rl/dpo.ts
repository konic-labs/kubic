// DPO exporter.
// Chat-format preference record over an eligible pair: the DPO builder
// delegates eligibility to buildPreferencePair, so env failures and
// cross-boundary runs can never reach a trainable DPO record —
// validation re-enforces the same policy on hand-crafted records: the
// boundary must be within (same worktree + same task role), env failures
// never validate, and the verifier must prefer chosen over rejected.
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import {
  buildPreferencePair,
  type ExcludedPair,
  PAIR_SCHEMA,
  validatePreferencePair,
} from './preference.js';
import { checkFailureCategory, checkProvenance, checkVerifier } from './sft.js';
import {
  isEnvFailure,
  type RlProvenance,
  type TrajectoryFailureCode,
} from './types.js';
import type { VerifierVerdict } from './verifier.js';

const DPO_SCHEMA = 'dpo/1';

interface DpoRecord {
  schema: typeof DPO_SCHEMA;
  prompt: string;
  chosen: string;
  rejected: string;
  provenance: { chosen: RlProvenance; rejected: RlProvenance };
  failureCategory: {
    chosen: TrajectoryFailureCode | null;
    rejected: TrajectoryFailureCode | null;
  };
  verifier: { chosen: VerifierVerdict; rejected: VerifierVerdict };
  roleRef: { chosen: string; rejected: string };
  // The task each side answered: validation refuses a record whose
  // sides answer different tasks.
  taskRef: { chosen: string; rejected: string };
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
      verifier: {
        chosen: pair.chosen.verifier,
        rejected: pair.rejected.verifier,
      },
      roleRef: {
        chosen: pair.chosen.roleRef,
        rejected: pair.rejected.roleRef,
      },
      taskRef: {
        chosen: pair.chosen.taskRef,
        rejected: pair.rejected.taskRef,
      },
      boundary: 'within',
    },
    excluded: null,
  };
}

function checkRoleRef(value: unknown, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${prefix} is required: carry both role refs`];
  }
  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const side of ['chosen', 'rejected'] as const) {
    if (!nonEmpty(candidate[side])) {
      errors.push(`${prefix}.${side} must be a role ref`);
    }
  }
  return errors;
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
  const provenance = candidate.provenance as
    | Record<string, unknown>
    | undefined;
  const failureCategory = candidate.failureCategory as
    | Record<string, unknown>
    | undefined;
  const verifier = candidate.verifier as Record<string, unknown> | undefined;
  const roleRef = candidate.roleRef as Record<string, unknown> | undefined;
  if (typeof provenance !== 'object' || provenance === null) {
    errors.push('provenance is required: carry both sides');
  } else {
    for (const message of checkProvenance(provenance.chosen)) {
      errors.push(`provenance.chosen.${message}`);
    }
    for (const message of checkProvenance(provenance.rejected)) {
      errors.push(`provenance.rejected.${message}`);
    }
  }
  if (typeof failureCategory !== 'object' || failureCategory === null) {
    errors.push('failureCategory is required: carry both sides');
  } else {
    for (const message of checkFailureCategory({
      failureCategory: failureCategory.chosen,
    })) {
      errors.push(`failureCategory.chosen.${message}`);
    }
    for (const message of checkFailureCategory({
      failureCategory: failureCategory.rejected,
    })) {
      errors.push(`failureCategory.rejected.${message}`);
    }
  }
  if (typeof verifier !== 'object' || verifier === null) {
    errors.push('verifier is required: carry both verdicts');
  } else {
    for (const message of checkVerifier(verifier.chosen)) {
      errors.push(`verifier.chosen.${message}`);
    }
    for (const message of checkVerifier(verifier.rejected)) {
      errors.push(`verifier.rejected.${message}`);
    }
  }
  errors.push(...checkRoleRef(roleRef, 'roleRef'));
  const taskRef = candidate.taskRef as Record<string, unknown> | undefined;
  if (typeof taskRef !== 'object' || taskRef === null) {
    errors.push('taskRef is required: carry both task refs');
  }
  // Direct semantic checks (mirroring the pair build policy) so
  // hand-crafted records fail even before the projected pair check.
  if (
    typeof failureCategory === 'object' &&
    failureCategory !== null &&
    (isEnvFailure(failureCategory.chosen as string | null) ||
      isEnvFailure(failureCategory.rejected as string | null))
  ) {
    errors.push(
      'env failure runs carry no capability signal: excluded from capability training',
    );
  }
  const chosenVerdict = (verifier?.chosen as VerifierVerdict | undefined)
    ?.verdict;
  const rejectedVerdict = (verifier?.rejected as VerifierVerdict | undefined)
    ?.verdict;
  if (
    typeof verifier === 'object' &&
    verifier !== null &&
    (chosenVerdict !== 'pass' || rejectedVerdict !== 'fail')
  ) {
    errors.push(
      `no verifier preference signal (chosen ${String(chosenVerdict)} vs rejected ${String(rejectedVerdict)})`,
    );
  }
  const chosenWorktree = (provenance?.chosen as RlProvenance | undefined)
    ?.worktree;
  const rejectedWorktree = (provenance?.rejected as RlProvenance | undefined)
    ?.worktree;
  const chosenRole = roleRef?.chosen as string | undefined;
  const rejectedRole = roleRef?.rejected as string | undefined;
  if (
    typeof provenance === 'object' &&
    provenance !== null &&
    typeof roleRef === 'object' &&
    roleRef !== null &&
    (chosenWorktree !== rejectedWorktree ||
      !nonEmpty(chosenRole) ||
      !nonEmpty(rejectedRole) ||
      chosenRole !== rejectedRole)
  ) {
    errors.push('chosen and rejected cross a worktree/role boundary');
  }
  // Reuse the pair-shape checks by projecting back onto a pair record
  // with the real role refs, task refs and verifier verdicts — never
  // placeholders (a placeholder task ref let mismatched tasks validate).
  const projected = {
    schema: PAIR_SCHEMA,
    prompt: candidate.prompt,
    boundary: candidate.boundary,
    chosen: {
      completion: candidate.chosen,
      provenance: provenance?.chosen,
      failureCategory: failureCategory?.chosen,
      verifier: verifier?.chosen,
      taskRef: taskRef?.chosen,
      worktreeRef: chosenWorktree ?? '',
      roleRef: chosenRole,
    },
    rejected: {
      completion: candidate.rejected,
      provenance: provenance?.rejected,
      failureCategory: failureCategory?.rejected,
      verifier: verifier?.rejected,
      taskRef: taskRef?.rejected,
      worktreeRef: rejectedWorktree ?? '',
      roleRef: rejectedRole,
    },
  };
  const pairCheck = validatePreferencePair(projected);
  if (!pairCheck.valid) errors.push(...pairCheck.errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, record: candidate as unknown as DpoRecord };
}
