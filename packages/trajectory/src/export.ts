// Trajectory exporter (issue #51; design §46).
// Fail-closed: provenance + the ACTUAL used ExecutionEnv snapshot are
// mandatory — a missing/incomplete provenance or env throws
// TrajectoryExportError (machine-readable code + non-zero exitCode),
// never a silently dropped section. The env recorded is the USED spawn
// env (post-allowlist §3.8 + role grant), never the intended config:
// callers must pass capturedFrom: 'used' or the build is refused.

import {
  isTrajectoryFailureCode,
  type JsonValue,
  SCHEMA_VERSION,
  type TrajectoryAction,
  type TrajectoryApproval,
  type TrajectoryDiff,
  type TrajectoryDurableState,
  type TrajectoryEnvironment,
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
  | 'invalid-usage';

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
// Secrecy contract (pinned by test, "records the used env VERBATIM"):
// the exporter records the used env VERBATIM — it never scrubs, redacts,
// or filters keys. A trajectory is a faithful record of what the run
// actually saw; silent scrubbing would make replays lie. Secrecy is
// enforced UPSTREAM at the spawn allowlist (#42, §3.8): secrets never
// enter the spawn env, so there is nothing to scrub here. This behavior
// is deliberate and pinned explicitly rather than left implicit.
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
  return environment;
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
  return usage;
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
    status !== 'budget_exhausted' &&
    status !== 'spawn_failed'
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
    identity: input.identity,
    model: input.model,
    prompt: input.prompt,
    resources: input.resources,
    transfer: input.transfer ?? null,
    actions: input.actions,
    observations: truncateObservations(input.observations),
    state: input.state,
    provenance,
    environment,
    worktree: input.worktree,
    diff: input.diff,
    approvals: input.approvals,
    timestamps,
    usage,
    result: { ...result, error },
    eval: input.eval ?? { suite: null, caseId: null, labels: {} },
  };
}

export type { JsonValue };
