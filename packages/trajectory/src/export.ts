// Trajectory exporter (issue #51; design §46).
// Fail-closed: provenance + the ACTUAL used ExecutionEnv snapshot are
// mandatory — a missing/incomplete provenance or env throws
// TrajectoryExportError (machine-readable code + non-zero exitCode),
// never a silently dropped section. The env recorded is the USED spawn
// env (post-allowlist §3.8 + role grant), never the intended config:
// callers must pass capturedFrom: 'used' or the build is refused.

import { redactSecretEnv } from '../../core/src/secret-keys.js';
import {
  isTrajectoryFailureCode,
  type JsonValue,
  SCHEMA_VERSION,
  type TrajectoryAction,
  type TrajectoryApproval,
  type TrajectoryDiff,
  type TrajectoryDurableState,
  type TrajectoryEnvironment,
  type TrajectoryEscalation,
  type TrajectoryEvalSlot,
  type TrajectoryExport,
  type TrajectoryIdentity,
  type TrajectoryModel,
  type TrajectoryObservation,
  type TrajectoryPrompt,
  type TrajectoryProvenance,
  type TrajectoryResources,
  type TrajectoryResult,
  type TrajectoryResultError,
  type TrajectoryTask,
  type TrajectoryTimestamps,
  type TrajectoryTransfer,
  type TrajectoryUsage,
  type TrajectoryWorktree,
} from './schema.js';

// Observations longer than this keep their byte count but are cut —
// trajectories stay shareable without hauling full tool output.
export const MAX_OBSERVATION_BYTES = 8 * 1024;

export type TrajectoryExportErrorCode =
  | 'missing-provenance'
  | 'invalid-provenance'
  | 'missing-environment'
  | 'untrusted-environment'
  | 'missing-failure-category'
  | 'contradictory-result'
  | 'invalid-timestamps'
  | 'invalid-usage'
  | 'invalid-escalation';

export class TrajectoryExportError extends Error {
  readonly code: TrajectoryExportErrorCode;
  readonly exitCode = 2;

  constructor(code: TrajectoryExportErrorCode, message: string) {
    super(message);
    this.name = 'TrajectoryExportError';
    this.code = code;
  }

  toJSON(): { error: { code: string; message: string; exitCode: number } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        exitCode: this.exitCode,
      },
    };
  }
}

export interface RawObservation {
  seq: number;
  actionSeq: number;
  output: string;
}

export interface BuildTrajectoryInput {
  task: TrajectoryTask;
  identity: TrajectoryIdentity;
  model: TrajectoryModel;
  prompt: TrajectoryPrompt;
  resources: TrajectoryResources;
  transfer?: TrajectoryTransfer | null;
  actions: TrajectoryAction[];
  observations: RawObservation[];
  state: TrajectoryDurableState;
  provenance: TrajectoryProvenance;
  environment: TrajectoryEnvironment;
  worktree: TrajectoryWorktree;
  diff: TrajectoryDiff;
  approvals: TrajectoryApproval[];
  timestamps: { startedAt: string; endedAt: string };
  usage: TrajectoryUsage;
  result: TrajectoryResult;
  eval?: TrajectoryEvalSlot | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkProvenance(input: BuildTrajectoryInput): TrajectoryProvenance {
  const provenance = input.provenance;
  if (!isRecord(provenance)) {
    throw new TrajectoryExportError(
      'missing-provenance',
      'trajectory export blocked: provenance is required (pid/generation/worktree/model) — refusing to emit a run that cannot be attributed',
    );
  }
  const p = provenance as unknown as Record<string, unknown>;
  if (!nonEmpty(p.sessionId) || !nonEmpty(p.agentId)) {
    throw new TrajectoryExportError(
      'invalid-provenance',
      'trajectory export blocked: provenance.sessionId and provenance.agentId must be non-empty strings',
    );
  }
  if (typeof p.generation !== 'number' || !(p.generation >= 0)) {
    throw new TrajectoryExportError(
      'invalid-provenance',
      'trajectory export blocked: provenance.generation must be a non-negative number',
    );
  }
  if (!nonEmpty(p.worktree) || !(p.worktree as string).startsWith('/')) {
    throw new TrajectoryExportError(
      'invalid-provenance',
      'trajectory export blocked: provenance.worktree must be an absolute path',
    );
  }
  if (!nonEmpty(p.model)) {
    throw new TrajectoryExportError(
      'invalid-provenance',
      'trajectory export blocked: provenance.model must be a non-empty string',
    );
  }
  if (p.pid !== null && (typeof p.pid !== 'number' || !(p.pid > 0))) {
    throw new TrajectoryExportError(
      'invalid-provenance',
      'trajectory export blocked: provenance.pid must be a positive number or an explicit null (faux runs) — never silently dropped',
    );
  }
  return provenance;
}

// §46r2/§3.8: record the env the run ACTUALLY used. The discriminator
// forces the caller to assert this — an intended/configured snapshot is
// refused, so a trajectory can never claim unrun config.
//
// Secrecy contract: every KEY the run saw is recorded, but the value of each
// secret-classified key is replaced with `<redacted>` — the same classifier
// (core/secret-keys.ts) the tool spawn path uses. A replay needing a secret
// re-resolves it; a trajectory never carries it.
function checkEnvironment(input: BuildTrajectoryInput): TrajectoryEnvironment {
  const environment = input.environment;
  if (!isRecord(environment)) {
    throw new TrajectoryExportError(
      'missing-environment',
      'trajectory export blocked: the actual used ExecutionEnv snapshot is required — refusing to emit a run that cannot be replayed',
    );
  }
  const e = environment as unknown as Record<string, unknown>;
  if (e.capturedFrom !== 'used') {
    throw new TrajectoryExportError(
      'untrusted-environment',
      `trajectory export blocked: environment.capturedFrom must be 'used' (got ${JSON.stringify(e.capturedFrom)}) — record the USED spawn env, never the intended config (§46r2/§3.8)`,
    );
  }
  if (!nonEmpty(e.cwd) || !isRecord(e.env)) {
    throw new TrajectoryExportError(
      'missing-environment',
      'trajectory export blocked: environment.cwd and environment.env (the used snapshot) are required',
    );
  }
  return {
    ...environment,
    env: redactSecretEnv(environment.env),
  };
}

function checkTimestamps(input: BuildTrajectoryInput): TrajectoryTimestamps {
  const timestamps = input.timestamps;
  if (!isRecord(timestamps)) {
    throw new TrajectoryExportError(
      'invalid-timestamps',
      'trajectory export blocked: timestamps.startedAt/endedAt are required',
    );
  }
  const t = timestamps as unknown as Record<string, unknown>;
  const startedAt = t.startedAt;
  const endedAt = t.endedAt;
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') {
    throw new TrajectoryExportError(
      'invalid-timestamps',
      'trajectory export blocked: timestamps.startedAt/endedAt must be ISO strings',
    );
  }
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new TrajectoryExportError(
      'invalid-timestamps',
      'trajectory export blocked: timestamps must parse and endedAt must not precede startedAt',
    );
  }
  return { startedAt, endedAt, durationMs: endMs - startMs };
}

function checkUsage(input: BuildTrajectoryInput): TrajectoryUsage {
  const usage = input.usage;
  if (!isRecord(usage)) {
    throw new TrajectoryExportError(
      'invalid-usage',
      'trajectory export blocked: usage rows (tokens + cost) are required',
    );
  }
  const u = usage as unknown as Record<string, unknown>;
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'requests',
    'costUsd',
  ]) {
    const value = u[key];
    if (typeof value !== 'number' || !(value >= 0)) {
      throw new TrajectoryExportError(
        'invalid-usage',
        `trajectory export blocked: usage.${key} must be a non-negative number`,
      );
    }
  }
  const byModel = u.byModel;
  if (byModel !== undefined) {
    if (!isRecord(byModel)) {
      throw new TrajectoryExportError(
        'invalid-usage',
        'trajectory export blocked: usage.byModel must be a record of per-model rows',
      );
    }
    for (const [model, row] of Object.entries(byModel)) {
      if (!isRecord(row)) {
        throw new TrajectoryExportError(
          'invalid-usage',
          `trajectory export blocked: usage.byModel[${JSON.stringify(model)}] must be a record`,
        );
      }
      const r = row as Record<string, unknown>;
      for (const key of ['requests', 'input', 'output', 'costTotal']) {
        const value = r[key];
        if (typeof value !== 'number' || !(value >= 0)) {
          throw new TrajectoryExportError(
            'invalid-usage',
            `trajectory export blocked: usage.byModel[${JSON.stringify(model)}].${key} must be a non-negative number`,
          );
        }
      }
    }
  }
  // Issue #331: the declared contract requires usage.byModel (a record of
  // per-model rows). A caller that omits it gets the empty record, never
  // an export the parser (and every consumer) would refuse.
  return {
    ...usage,
    byModel: (isRecord(byModel) ? byModel : {}) as TrajectoryUsage['byModel'],
  };
}

// §52 on failures: every non-completed result carries its failure
// category; a completed result carrying an error is contradictory.
function checkResult(input: BuildTrajectoryInput): TrajectoryResult {
  const result = input.result;
  if (!isRecord(result)) {
    throw new TrajectoryExportError(
      'contradictory-result',
      'trajectory export blocked: result is required',
    );
  }
  const r = result as unknown as Record<string, unknown>;
  const status = r.status;
  if (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'timeout' &&
    status !== 'turn_limit'
  ) {
    throw new TrajectoryExportError(
      'contradictory-result',
      `trajectory export blocked: result.status ${JSON.stringify(status)} is unknown`,
    );
  }
  const failureCategory = r.failureCategory as unknown;
  const error = r.error as unknown;
  if (status === 'completed') {
    if (error !== null && error !== undefined) {
      throw new TrajectoryExportError(
        'contradictory-result',
        'trajectory export blocked: a completed result must not carry an error',
      );
    }
    if (failureCategory !== null && failureCategory !== undefined) {
      throw new TrajectoryExportError(
        'contradictory-result',
        'trajectory export blocked: a completed result must not carry a failureCategory (mirror of the completed+error check)',
      );
    }
    return result;
  }
  if (
    typeof failureCategory !== 'string' ||
    !isTrajectoryFailureCode(failureCategory)
  ) {
    throw new TrajectoryExportError(
      'missing-failure-category',
      `trajectory export blocked: result.status ${JSON.stringify(status)} requires a §52 failureCategory`,
    );
  }
  if (error !== null && error !== undefined) {
    const e = error as Record<string, unknown>;
    if (!nonEmpty(e.kind) || !nonEmpty(e.message)) {
      throw new TrajectoryExportError(
        'contradictory-result',
        'trajectory export blocked: result.error needs kind + message',
      );
    }
  }
  return result as TrajectoryResult;
}

// 1.1 (issue #329): every escalation must name the model it moved to —
// an escalation without a target cannot be attributed to a model in RL
// pairing or cost analysis. Fail-closed, never a silently target-less
// record.
function checkEscalations(
  escalations: TrajectoryEscalation[],
): TrajectoryEscalation[] {
  return escalations.map((escalation, index) => {
    const toModel = escalation?.toModel;
    if (typeof toModel !== 'string' || toModel.trim() === '') {
      throw new TrajectoryExportError(
        'invalid-escalation',
        `trajectory export blocked: model.escalations[${index}].toModel is required — an escalation without its target model cannot be attributed`,
      );
    }
    return escalation;
  });
}

function truncateObservations(
  observations: RawObservation[],
): TrajectoryObservation[] {
  return observations.map((observation) => {
    const bytesOriginal = Buffer.byteLength(observation.output, 'utf8');
    if (bytesOriginal <= MAX_OBSERVATION_BYTES) {
      return {
        seq: observation.seq,
        actionSeq: observation.actionSeq,
        output: observation.output,
        truncated: false,
        bytesOriginal,
      };
    }
    // Truncate on a UTF-8 character boundary: slicing the encoded bytes
    // at MAX_OBSERVATION_BYTES can split a multi-byte character, and
    // decoding the split emits U+FFFD (3 bytes) — pushing the result OVER
    // the cap (15000 CJK bytes → 8193 > 8192). Walk whole characters
    // instead, so the byte cap holds exactly and no replacement char
    // can appear.
    let end = 0;
    let keptBytes = 0;
    for (const ch of observation.output) {
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (keptBytes + chBytes > MAX_OBSERVATION_BYTES) break;
      keptBytes += chBytes;
      end += ch.length;
    }
    return {
      seq: observation.seq,
      actionSeq: observation.actionSeq,
      output: observation.output.slice(0, end),
      truncated: true,
      bytesOriginal,
    };
  });
}

export function buildTrajectoryExport(
  input: BuildTrajectoryInput,
): TrajectoryExport {
  const provenance = checkProvenance(input);
  const environment = checkEnvironment(input);
  const timestamps = checkTimestamps(input);
  const usage = checkUsage(input);
  const result = checkResult(input);
  const error: TrajectoryResultError | null =
    result.error === undefined ? null : result.error;
  return {
    schema_version: SCHEMA_VERSION,
    task: input.task,
    identity: {
      ...input.identity,
      // 1.1 (issue #329): ancestry + agent role. An absent parent is an
      // explicit null and an absent role falls back to the task's own —
      // a 1.1 write never omits the fields.
      parentSessionId: input.identity.parentSessionId ?? null,
      role: input.identity.role ?? input.task.role,
    },
    model: {
      ...input.model,
      escalations: checkEscalations(input.model.escalations),
    },
    prompt: input.prompt,
    resources: input.resources,
    transfer: input.transfer ?? null,
    actions: input.actions,
    observations: truncateObservations(input.observations),
    state: {
      ...input.state,
      // 1.1: no leaf/memo recorded is an empty list, never a missing key.
      operations: input.state.operations ?? [],
      memos: input.state.memos ?? [],
    },
    provenance,
    environment,
    worktree: input.worktree,
    diff: input.diff,
    approvals: input.approvals.map((approval) => ({
      ...approval,
      // 1.1: null means not recorded — never an invented justification.
      requested: approval.requested ?? null,
      justification: approval.justification ?? null,
    })),
    timestamps,
    usage,
    result: {
      ...result,
      error,
      // 1.1: refs only; no evidence recorded is an empty list.
      tests: result.tests ?? [],
      artifacts: result.artifacts ?? [],
    },
    eval: input.eval ?? { suite: null, caseId: null, labels: {} },
  };
}

export type { JsonValue };
