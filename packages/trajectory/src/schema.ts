// Versioned trajectory export schema.
// The published stable contract: every autonomous run may emit one of
// these records for replay/bench/SFT/RL/debug. Consumers (replay,
// eval) read it with parseTrajectoryExport — no shim, no adapter.
//
// Shape ownership (read-only — this package never modifies them):
//   Provenance/ExecutionEnv in packages/exec/src/env.ts,
//   ResultStatus in packages/worker/src/lane/settle.ts,
//   FileChange diffs in packages/exec/src/journal-diff.ts,
//   ApprovalPolicy/verdicts in packages/host/src/approvals.ts,
//   KubicUsageRow in packages/worker/src/usage.ts,
//   FAILURE_CODES in packages/worker/src/lane/failures.ts.
// This package imports none of them (dep-lint: trajectory sits below the
// runtime implementations) — the structural interfaces below are
// snapshots of those shapes, pinned by the golden fixture test.

export const SCHEMA_VERSION = '1.3';
export const SCHEMA_MAJOR = 1;

// Stability promise: `stable` means additive-only within a major —
// replay and eval pinned to major 1 keep parsing.
export const TRAJECTORY_STABILITY = 'stable' as const;

export interface TrajectoryChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const TRAJECTORY_CHANGELOG: readonly TrajectoryChangelogEntry[] = [
  {
    version: '1.3',
    date: '2026-10-07',
    changes: [
      'Run budgets were removed: the optional budget block is gone (an older record that carries one still parses; the block is ignored).',
      'The --max-turns stop reports result.status turn_limit with failure category run_limit; a wall-clock timeout also carries run_limit.',
      'Records that carry the retired budget_exhausted status or category, or the retired spawn_failed status, no longer parse.',
    ],
  },
  {
    version: '1.2',
    date: '2026-10-05',
    changes: [
      'Budget observability: optional top-level budget block — limits (the max* dims the run started with), usage (measured tokens/costUsd/toolCalls) and exhausted (the breaching limit with used/max when known).',
      '1.1 records still parse: the whole budget block is optional on read.',
    ],
  },
  {
    version: '1.1',
    date: '2026-10-04',
    changes: [
      'Additive identity: identity.parentSessionId + identity.role (task.role stays the task record).',
      'Escalation attribution: model.escalations[].fromModel/toModel/thinking (toModel required on write).',
      'Approval audit: approvals[].requested (redacted summary) + justification.',
      'Durable-state leaves: state.operations[] (id/kind) + state.memos[] refs.',
      'Result evidence: result.tests + result.artifacts refs.',
      '1.0 records still parse: every 1.1 field is optional on read.',
    ],
  },
  {
    version: '1.0',
    date: '2026-09-23',
    changes: [
      'Initial stable export: all trajectory fields with mandatory provenance + used-environment snapshot (fail-closed).',
      'failure categories required on every non-completed result.',
      'Observations truncated at MAX_OBSERVATION_BYTES with byte counts kept.',
      'Reserved eval slot; replay pins readable with no shim.',
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

// Failure taxonomy — snapshot of FAILURE_CODES owned by
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
  'run_limit',
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
  'turn_limit',
] as const;

export type TrajectoryResultStatus = (typeof RESULT_STATUSES)[number];

// Trajectory fields, in issue order.
export interface TrajectoryTask {
  taskId: string;
  objective: string;
  role: string;
}

export interface TrajectoryIdentity {
  sessionId: string;
  agentId: string;
  workerId: string | null;
  // 1.1 (additive): the parent session (always null — a run is never a
  // child of another run) and the agent's own role. `task.role` stays the
  // task's record; `role` is the agent identity.
  parentSessionId?: string | null;
  role?: string;
}

export interface TrajectoryEscalation {
  reason: string;
  at: string;
  // 1.1: the escalation's endpoints and the thinking level
  // it moved to. `toModel` is required on write — the exporter refuses an
  // escalation that cannot be attributed to a target model.
  fromModel?: string;
  toModel?: string;
  thinking?: string | null;
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
  // 1.1: the operation leaves traversed and memo refs.
  operations?: TrajectoryOperation[];
  memos?: string[];
}

interface TrajectoryOperation {
  id: string;
  kind: string;
}

// Provenance: pid/generation/worktree/model. pid is an explicit
// null when no OS process exists (faux runs) — never silently dropped.
export interface TrajectoryProvenance {
  sessionId: string;
  agentId: string;
  pid: number | null;
  generation: number;
  worktree: string;
  model: string;
}

// The ACTUAL ExecutionEnv the run executed with: the
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

interface TrajectoryDiffFile {
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
  // 1.1: the redacted request summary and the decider's
  // justification. `null` means not recorded — never an invented value.
  requested?: string | null;
  justification?: string | null;
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
  // 1.1: refs only — the test and artifact evidence the run
  // produced, never embedded contents.
  tests?: string[];
  artifacts?: string[];
}

// Eval slot: stable reserved position, filled by the
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

// Closed-world field coverage: adding or removing a trajectory section breaks
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

// Structural validation: presence is not enough. A
// published contract read from community files must fail closed with a
// named path BEFORE a consumer dereferences a section — an `actions:
// null` must not reach replay and die as a raw TypeError (generic exit 1)
// instead of TrajectorySchemaError 'malformed'. Types only: unknown extra
// keys survive (additive-only within major 1), and internals beyond the
// required keys stay the exporter's job.
type FieldType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'string|null'
  | 'number|null'
  | 'object|null'
  | 'string[]'
  // `state.snapshot` is JsonValue: any JSON value, but the key must exist.
  | 'json';

// The required nested keys of every object section. `transfer` is
// object|null and `actions`/`observations`/`approvals` are arrays, so
// they are listed separately below.
const SECTION_FIELDS: Readonly<
  Record<string, Readonly<Record<string, FieldType>>>
> = {
  task: { taskId: 'string', objective: 'string', role: 'string' },
  identity: { sessionId: 'string', agentId: 'string', workerId: 'string|null' },
  model: {
    provider: 'string',
    model: 'string',
    thinking: 'string|null',
    escalations: 'array',
  },
  prompt: { text: 'string', constraints: 'string[]' },
  resources: { skills: 'string[]', promptTemplates: 'string[]' },
  state: { phase: 'string', snapshot: 'json' },
  provenance: {
    sessionId: 'string',
    agentId: 'string',
    pid: 'number|null',
    generation: 'number',
    worktree: 'string',
    model: 'string',
  },
  environment: { capturedFrom: 'string', cwd: 'string', env: 'object' },
  worktree: { path: 'string', baseRevision: 'string', branch: 'string|null' },
  diff: { filesChanged: 'string[]', files: 'array' },
  timestamps: { startedAt: 'string', endedAt: 'string', durationMs: 'number' },
  usage: {
    inputTokens: 'number',
    outputTokens: 'number',
    cachedTokens: 'number',
    requests: 'number',
    costUsd: 'number',
    byModel: 'object',
  },
  result: {
    status: 'string',
    summary: 'string',
    failureCategory: 'string|null',
    error: 'object|null',
  },
  eval: { suite: 'string|null', caseId: 'string|null', labels: 'object' },
};

const ARRAY_SECTIONS = ['actions', 'observations', 'approvals'] as const;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function malformed(path: string, detail: string): never {
  throw new TrajectorySchemaError('malformed', `trajectory.${path} ${detail}`);
}

function fieldMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'string|null':
      return value === null || typeof value === 'string';
    case 'number|null':
      return value === null || typeof value === 'number';
    case 'object|null':
      return value === null || isRecord(value);
    case 'string[]':
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string')
      );
    case 'json':
      return true;
  }
}

function expectedOf(type: FieldType): string {
  switch (type) {
    case 'object':
      return 'an object';
    case 'array':
      return 'an array';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'string|null':
      return 'a string or null';
    case 'number|null':
      return 'a number or null';
    case 'object|null':
      return 'an object or null';
    case 'string[]':
      return 'an array of strings';
    case 'json':
      return 'a JSON value';
  }
}

function checkTrajectoryShape(input: Record<string, unknown>): void {
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const value = input[section];
    if (!isRecord(value)) {
      malformed(section, `must be an object (got ${describeValue(value)})`);
    }
    for (const [field, type] of Object.entries(fields)) {
      if (!(field in value)) {
        malformed(`${section}.${field}`, 'is required');
      }
      const fieldValue = value[field];
      if (!fieldMatches(type, fieldValue)) {
        malformed(
          `${section}.${field}`,
          `must be ${expectedOf(type)} (got ${describeValue(fieldValue)})`,
        );
      }
    }
  }
  for (const section of ARRAY_SECTIONS) {
    const value = input[section];
    if (!Array.isArray(value)) {
      malformed(section, `must be an array (got ${describeValue(value)})`);
    }
  }
  const transfer = input.transfer;
  if (transfer !== null && !isRecord(transfer)) {
    malformed(
      'transfer',
      `must be an object or null (got ${describeValue(transfer)})`,
    );
  }
  // Guaranteed to be an object by the section loop above.
  const result = input.result as Record<string, unknown>;
  const status = result.status;
  if (
    typeof status !== 'string' ||
    !(RESULT_STATUSES as readonly string[]).includes(status)
  ) {
    malformed(
      'result.status',
      `must be one of ${RESULT_STATUSES.join('|')} (got ${JSON.stringify(status)})`,
    );
  }
}

// 1.1 additions are additive: a 1.0 record omits them and
// still parses. When present they are type-checked, so the reader never
// hands a consumer an unvalidated new field.
const OPTIONAL_SECTION_FIELDS: Readonly<
  Record<string, Readonly<Record<string, FieldType>>>
> = {
  identity: { parentSessionId: 'string|null', role: 'string' },
  state: { operations: 'array', memos: 'string[]' },
  result: { tests: 'string[]', artifacts: 'string[]' },
};

const OPTIONAL_ESCALATION_FIELDS: Readonly<Record<string, FieldType>> = {
  fromModel: 'string',
  toModel: 'string',
  thinking: 'string|null',
};

const OPTIONAL_APPROVAL_FIELDS: Readonly<Record<string, FieldType>> = {
  requested: 'string|null',
  justification: 'string|null',
};

const OPERATION_FIELDS: Readonly<Record<string, FieldType>> = {
  id: 'string',
  kind: 'string',
};

function checkOptionalFields(
  record: Record<string, unknown>,
  path: string,
  fields: Readonly<Record<string, FieldType>>,
  required: boolean,
): void {
  for (const [field, type] of Object.entries(fields)) {
    if (!(field in record)) {
      if (required) malformed(`${path}.${field}`, 'is required');
      continue;
    }
    const value = record[field];
    if (!fieldMatches(type, value)) {
      malformed(
        `${path}.${field}`,
        `must be ${expectedOf(type)} (got ${describeValue(value)})`,
      );
    }
  }
}

function checkOptionalShape(input: Record<string, unknown>): void {
  for (const [section, fields] of Object.entries(OPTIONAL_SECTION_FIELDS)) {
    const value = input[section];
    if (!isRecord(value)) continue; // the required pass already refused it
    checkOptionalFields(value, section, fields, false);
  }
  const model = input.model as Record<string, unknown>;
  const escalations = model.escalations;
  if (Array.isArray(escalations)) {
    escalations.forEach((entry, index) => {
      const path = `model.escalations[${index}]`;
      if (!isRecord(entry)) {
        malformed(path, `must be an object (got ${describeValue(entry)})`);
      }
      checkOptionalFields(entry, path, OPTIONAL_ESCALATION_FIELDS, false);
    });
  }
  const approvals = input.approvals;
  if (Array.isArray(approvals)) {
    approvals.forEach((entry, index) => {
      const path = `approvals[${index}]`;
      if (!isRecord(entry)) {
        malformed(path, `must be an object (got ${describeValue(entry)})`);
      }
      checkOptionalFields(entry, path, OPTIONAL_APPROVAL_FIELDS, false);
    });
  }
  const state = input.state as Record<string, unknown>;
  const operations = state.operations;
  if (Array.isArray(operations)) {
    operations.forEach((entry, index) => {
      const path = `state.operations[${index}]`;
      if (!isRecord(entry)) {
        malformed(path, `must be an object (got ${describeValue(entry)})`);
      }
      checkOptionalFields(entry, path, OPERATION_FIELDS, true);
    });
  }
}

// Consumer entry for replay and eval: strict major gate,
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
  // The closed-world map above breaks compilation when a section is
  // added or removed.
  for (const field of Object.keys(TRAJECTORY_FIELDS)) {
    if (!(field in input)) {
      throw new TrajectorySchemaError(
        'malformed',
        `trajectory is missing field ${JSON.stringify(field)}`,
      );
    }
  }
  checkTrajectoryShape(input);
  checkOptionalShape(input);
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
