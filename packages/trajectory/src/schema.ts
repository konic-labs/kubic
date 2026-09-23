// Versioned trajectory export schema (issue #51; design §46).
// The published stable contract: every autonomous run may emit one of
// these records for replay/bench/SFT/RL/debug. Consumers (replay #52,
// eval #53) read it with parseTrajectoryExport — no shim, no adapter.
//
// Shape ownership (read-only — this package never modifies them):
//   Provenance/ExecutionEnv in packages/exec/src/env.ts,
//   AgentResult in packages/worker/src/result.ts,
//   AgentTask/transfer in packages/agents/src/task.ts + transfer.ts,
//   FileChange diffs in packages/exec/src/journal-diff.ts,
//   ApprovalPolicy/verdicts in packages/host/src/approvals.ts,
//   KubicUsageRow in packages/worker/src/usage.ts,
//   §52 FAILURE_CODES in packages/worker/src/lane/failures.ts.
// This package imports none of them (dep-lint: trajectory sits below the
// runtime implementations) — the structural interfaces below are
// snapshots of those shapes, pinned by the golden fixture test.

export const SCHEMA_VERSION = '1.0';
export const SCHEMA_MAJOR = 1;
export const SCHEMA_MINOR = 0;

// Stability promise: `stable` means additive-only within a major —
// replay (#52) and eval (#53) pinned to major 1 keep parsing.
export const TRAJECTORY_STABILITY = 'stable' as const;
export type TrajectoryStability = typeof TRAJECTORY_STABILITY;

export interface TrajectoryChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const TRAJECTORY_CHANGELOG: readonly TrajectoryChangelogEntry[] = [
  {
    version: '1.0',
    date: '2026-09-23',
    changes: [
      'Initial stable export: all §46 fields with mandatory provenance + used-environment snapshot (fail-closed).',
      '§52 failure categories required on every non-completed result.',
      'Observations truncated at MAX_OBSERVATION_BYTES with byte counts kept.',
      'Reserved eval slot for issue #53; replay pins readable with no shim.',
    ],
  },
] as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// §52 failure taxonomy — snapshot of FAILURE_CODES owned by
// packages/worker/src/lane/failures.ts. The worker owns the spelling;
// this list is pinned equal by test so a drift breaks loudly here.
export const TRAJECTORY_FAILURE_CODES = [
  'model_failed',
  'model_refused',
  'provider_transient',
  'provider_auth',
  'tool_failed',
  'tool_invalid_args',
  'tool_timeout',
  'tool_unavailable',
  'process_crashed',
  'process_spawn_failed',
  'workspace_failed',
  'context_overflow',
  'context_polluted',
  'budget_exhausted',
  'approval_denied',
  'approval_timed_out',
] as const;

export type TrajectoryFailureCode = (typeof TRAJECTORY_FAILURE_CODES)[number];

export function isTrajectoryFailureCode(
  value: string,
): value is TrajectoryFailureCode {
  return (TRAJECTORY_FAILURE_CODES as readonly string[]).includes(value);
}

export const RESULT_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'budget_exhausted',
  'spawn_failed',
] as const;

export type TrajectoryResultStatus = (typeof RESULT_STATUSES)[number];

// §46 fields, in issue order.
export interface TrajectoryTask {
  taskId: string;
  objective: string;
  role: string;
}

export interface TrajectoryIdentity {
  sessionId: string;
  agentId: string;
  workerId: string | null;
}

export interface TrajectoryEscalation {
  reason: string;
  at: string;
}

export interface TrajectoryModel {
  provider: string;
  model: string;
  thinking: string | null;
  escalations: TrajectoryEscalation[];
}

export interface TrajectoryPrompt {
  text: string;
  constraints: string[];
}

export interface TrajectoryResources {
  skills: string[];
  promptTemplates: string[];
}

export interface TrajectoryTransfer {
  taskId: string;
  worktree: string;
  grantRef: string;
}

export interface TrajectoryAction {
  seq: number;
  tool: string;
  args: JsonValue;
}

export interface TrajectoryObservation {
  seq: number;
  actionSeq: number;
  output: string;
  truncated: boolean;
  bytesOriginal: number;
}

export interface TrajectoryDurableState {
  phase: string;
  snapshot: JsonValue;
}

// §46 provenance: pid/generation/worktree/model. pid is an explicit
// null when no OS process exists (faux runs) — never silently dropped.
export interface TrajectoryProvenance {
  sessionId: string;
  agentId: string;
  pid: number | null;
  generation: number;
  worktree: string;
  model: string;
}

// The ACTUAL ExecutionEnv the run executed with (§46r2, §3.8): the
// post-allowlist spawn env, never the intended/configured env.
// capturedFrom is a literal discriminator — anything but 'used' is
// refused at build time (see untrusted-environment).
export interface TrajectoryEnvironment {
  capturedFrom: 'used';
  cwd: string;
  env: Record<string, string>;
}

export interface TrajectoryWorktree {
  path: string;
  baseRevision: string;
  branch: string | null;
}

export interface TrajectoryDiffFile {
  path: string;
  hunks: string[];
}

export interface TrajectoryDiff {
  filesChanged: string[];
  files: TrajectoryDiffFile[];
}

export interface TrajectoryApproval {
  approvalId: string;
  capability: string;
  verdict: 'approved' | 'denied' | 'timed-out';
  by: string | null;
}

export interface TrajectoryTimestamps {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface TrajectoryModelUsage {
  requests: number;
  input: number;
  output: number;
  costTotal: number;
}

export interface TrajectoryUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  costUsd: number;
  byModel: Record<string, TrajectoryModelUsage>;
}

export interface TrajectoryResultError {
  kind: string;
  message: string;
}

export interface TrajectoryResult {
  status: TrajectoryResultStatus;
  summary: string;
  failureCategory: TrajectoryFailureCode | null;
  error: TrajectoryResultError | null;
}

// Eval slot owned by issue #53: stable reserved position, filled by the
// eval harness. Exporters leave it null-labelled; eval reads it with no
// shim via parseTrajectoryExport.
export interface TrajectoryEvalSlot {
  suite: string | null;
  caseId: string | null;
  labels: Record<string, string>;
}

export interface TrajectoryExport {
  schema_version: string;
  task: TrajectoryTask;
  identity: TrajectoryIdentity;
  model: TrajectoryModel;
  prompt: TrajectoryPrompt;
  resources: TrajectoryResources;
  transfer: TrajectoryTransfer | null;
  actions: TrajectoryAction[];
  observations: TrajectoryObservation[];
  state: TrajectoryDurableState;
  provenance: TrajectoryProvenance;
  environment: TrajectoryEnvironment;
  worktree: TrajectoryWorktree;
  diff: TrajectoryDiff;
  approvals: TrajectoryApproval[];
  timestamps: TrajectoryTimestamps;
  usage: TrajectoryUsage;
  result: TrajectoryResult;
  eval: TrajectoryEvalSlot;
}

// Closed-world field coverage: adding or removing a §46 section breaks
// compilation here, so the contract cannot drift silently.
export const TRAJECTORY_FIELDS = {
  schema_version: true,
  task: true,
  identity: true,
  model: true,
  prompt: true,
  resources: true,
  transfer: true,
  actions: true,
  observations: true,
  state: true,
  provenance: true,
  environment: true,
  worktree: true,
  diff: true,
  approvals: true,
  timestamps: true,
  usage: true,
  result: true,
  eval: true,
} satisfies Record<keyof TrajectoryExport, true>;

export type TrajectorySchemaErrorCode = 'unknown-major' | 'malformed';

export class TrajectorySchemaError extends Error {
  readonly code: TrajectorySchemaErrorCode;
  readonly exitCode = 3;

  constructor(code: TrajectorySchemaErrorCode, message: string) {
    super(message);
    this.name = 'TrajectorySchemaError';
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

function majorOf(version: string): number | null {
  const match = /^(\d+)\.\d+$/.exec(version.trim());
  if (match === null || match[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Consumer entry for replay (#52) and eval (#53): strict major gate,
// tolerant minor — same-major records parse with no shim; unknown fields
// are preserved, unknown majors are refused loudly.
export function parseTrajectoryExport(input: unknown): TrajectoryExport {
  if (!isRecord(input)) {
    throw new TrajectorySchemaError(
      'malformed',
      'trajectory must be a JSON object',
    );
  }
  const version = input.schema_version;
  if (typeof version !== 'string') {
    throw new TrajectorySchemaError(
      'malformed',
      'trajectory.schema_version must be a "major.minor" string',
    );
  }
  const major = majorOf(version);
  if (major === null) {
    throw new TrajectorySchemaError(
      'malformed',
      `trajectory.schema_version ${JSON.stringify(version)} is not "major.minor"`,
    );
  }
  if (major !== SCHEMA_MAJOR) {
    throw new TrajectorySchemaError(
      'unknown-major',
      `unsupported trajectory major ${major} (this reader supports major ${SCHEMA_MAJOR}; schema_version ${JSON.stringify(version)})`,
    );
  }
  for (const field of Object.keys(TRAJECTORY_FIELDS)) {
    if (!(field in input)) {
      throw new TrajectorySchemaError(
        'malformed',
        `trajectory is missing §46 field ${JSON.stringify(field)}`,
      );
    }
  }
  return input as unknown as TrajectoryExport;
}

export function parseTrajectoryExportJSON(json: string): TrajectoryExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new TrajectorySchemaError(
      'malformed',
      'trajectory is not valid JSON',
    );
  }
  return parseTrajectoryExport(parsed);
}
