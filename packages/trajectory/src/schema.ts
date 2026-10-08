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

export const SCHEMA_VERSION = '1.0';
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
    version: '1.0',
    date: '2026-10-08',
    changes: ['Initial export contract.'],
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

export interface TrajectoryTask {
  taskId: string;
  objective: string;
  // The role the run ran as: 'solo', or the `--role` name.
  role: string;
}

export interface TrajectoryIdentity {
  sessionId: string;
  agentId: string;
}

export interface TrajectoryEscalation {
  reason: string;
  at: string;
  // The model the escalation moved from and to, and the thinking level it
  // moved to. The writer always records all three, and `toModel` must name the
  // target: an escalation that cannot be attributed to a model cannot be used
  // in RL pairing or cost analysis. The reader takes an endpoint that an
  // earlier build did not record as null.
  fromModel: string | null;
  toModel: string | null;
  thinking: string | null;
}

export interface TrajectoryModel {
  provider: string;
  model: string;
  thinking: string | null;
  escalations: TrajectoryEscalation[];
}

export interface TrajectoryPrompt {
  text: string;
}

export interface TrajectoryResources {
  skills: string[];
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
}

// Provenance: pid/worktree/model. pid is an explicit
// null when no OS process exists (faux runs) — never silently dropped.
export interface TrajectoryProvenance {
  sessionId: string;
  agentId: string;
  pid: number | null;
  worktree: string;
  model: string;
}

// The ACTUAL ExecutionEnv the run executed with: the
// post-allowlist spawn env, never the intended/configured env.
// capturedFrom is the record's provenance assertion: the reader refuses any
// value but 'used' (see malformed), so a record can never claim unrun config.
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

// The eval slot: the run verifier's `signal:*` gate labels, read by eval
// with no shim via parseTrajectoryExport. Empty when no verifier ran.
export interface TrajectoryEvalSlot {
  labels: Record<string, string>;
}

export interface TrajectoryExport {
  schema_version: string;
  task: TrajectoryTask;
  identity: TrajectoryIdentity;
  model: TrajectoryModel;
  prompt: TrajectoryPrompt;
  resources: TrajectoryResources;
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
  | 'string[]';

// The required keys of every object section. `transfer` is gone, and
// `actions`/`observations`/`approvals` are arrays, so they are listed
// separately below.
const SECTION_FIELDS: Readonly<
  Record<string, Readonly<Record<string, FieldType>>>
> = {
  task: { taskId: 'string', objective: 'string', role: 'string' },
  identity: { sessionId: 'string', agentId: 'string' },
  model: {
    provider: 'string',
    model: 'string',
    thinking: 'string|null',
    escalations: 'array',
  },
  prompt: { text: 'string' },
  resources: { skills: 'string[]' },
  state: { phase: 'string' },
  provenance: {
    sessionId: 'string',
    agentId: 'string',
    pid: 'number|null',
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
  eval: { labels: 'object' },
};

const ARRAY_SECTIONS = ['actions', 'observations', 'approvals'] as const;

// An escalation names when it happened and why. Its endpoints and thinking
// level are read tolerantly: an earlier build could record an escalation
// without them, and a record of that shape still parses. When present, each is
// type-checked. A read fills an absent endpoint with null, so the null is a
// valid value on the next read too: a consumer may parse a parsed export.
const ESCALATION_FIELDS: Readonly<Record<string, FieldType>> = {
  reason: 'string',
  at: 'string',
};

const ESCALATION_OPTIONAL_FIELDS: Readonly<Record<string, FieldType>> = {
  fromModel: 'string|null',
  toModel: 'string|null',
  thinking: 'string|null',
};

const APPROVAL_FIELDS: Readonly<Record<string, FieldType>> = {
  approvalId: 'string',
  capability: 'string',
  verdict: 'string',
  by: 'string|null',
};

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
  }
}

function checkFields(
  record: Record<string, unknown>,
  path: string,
  fields: Readonly<Record<string, FieldType>>,
): void {
  for (const [field, type] of Object.entries(fields)) {
    if (!(field in record)) {
      malformed(`${path}.${field}`, 'is required');
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

// Each entry of an array section is an object with the required keys. Keys
// listed as optional are type-checked only when the entry carries them.
function checkEntries(
  entries: unknown[],
  path: string,
  fields: Readonly<Record<string, FieldType>>,
  optional: Readonly<Record<string, FieldType>> = {},
): void {
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      malformed(entryPath, `must be an object (got ${describeValue(entry)})`);
    }
    checkFields(entry, entryPath, fields);
    for (const [field, type] of Object.entries(optional)) {
      if (!(field in entry)) continue;
      const value = entry[field];
      if (!fieldMatches(type, value)) {
        malformed(
          `${entryPath}.${field}`,
          `must be ${expectedOf(type)} (got ${describeValue(value)})`,
        );
      }
    }
  });
}

function checkTrajectoryShape(input: Record<string, unknown>): void {
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const value = input[section];
    if (!isRecord(value)) {
      malformed(section, `must be an object (got ${describeValue(value)})`);
    }
    checkFields(value, section, fields);
  }
  for (const section of ARRAY_SECTIONS) {
    const value = input[section];
    if (!Array.isArray(value)) {
      malformed(section, `must be an array (got ${describeValue(value)})`);
    }
  }
  // Guaranteed to be an object by the section loop above.
  const environment = input.environment as Record<string, unknown>;
  if (environment.capturedFrom !== 'used') {
    malformed(
      'environment.capturedFrom',
      `must be 'used' (got ${JSON.stringify(environment.capturedFrom)})`,
    );
  }
  const model = input.model as Record<string, unknown>;
  checkEntries(
    model.escalations as unknown[],
    'model.escalations',
    ESCALATION_FIELDS,
    ESCALATION_OPTIONAL_FIELDS,
  );
  checkEntries(input.approvals as unknown[], 'approvals', APPROVAL_FIELDS);
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
  return withEscalationEndpoints(input);
}

// An endpoint an earlier build did not record reads as null, so a consumer sees
// one escalation shape for every record. Unknown keys inside an entry survive.
function withEscalationEndpoints(
  input: Record<string, unknown>,
): TrajectoryExport {
  const model = input.model as Record<string, unknown>;
  const escalations = (model.escalations as Record<string, unknown>[]).map(
    (entry) => ({
      ...entry,
      fromModel: entry.fromModel ?? null,
      toModel: entry.toModel ?? null,
      thinking: entry.thinking ?? null,
    }),
  );
  return {
    ...input,
    model: { ...model, escalations },
  } as unknown as TrajectoryExport;
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
