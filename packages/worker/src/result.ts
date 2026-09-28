// AgentResult worker-result contract (issue #7; design §68).
// The only worker → host payload. Provenance is required on EVERY result,
// including failures: a failed agent that does not report how it ran cannot
// be diagnosed or replayed. Results never carry transcripts (§69).
//
// Status overlap note: 'budget_exhausted' also exists as BudgetTermination in
// @kubic/agents. Each contract owns its literal (contracts are versioned and
// snapshotted independently); the spelling is pinned by tests on both sides.
//
// Stub types refined by their owners: TestResult/ArtifactRef/WorkspaceDiffRef
// in #52–#53 (replay/eval), WorkerProvenance in #42 (worker lifecycle),
// ApprovalRecord in #48 (approval routing), EscalationRecord in #8 (handoff).

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const RESULT_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'budget_exhausted',
  'spawn_failed',
] as const;

export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ERROR_KINDS = [
  'model',
  'provider',
  'tool',
  'process',
  'workspace',
  'context',
  'budget',
  'approval',
] as const;

export type ResultErrorKind = (typeof ERROR_KINDS)[number];

export interface ResultError {
  kind: ResultErrorKind;
  message: string;
  details?: JsonValue;
}

export interface TestResult {
  name: string;
  passed: boolean;
  output?: string;
}

export interface ArtifactRef {
  artifactId: string;
}

export interface WorkspaceDiffRef {
  diffId: string;
}

// §46/§68 (issue #185): who ran, where, as what, on which model. Required
// on every result — failures included — so a result alone can be
// diagnosed and replayed. `pid` is null only when no process ever existed
// (a spawn that never produced one); `model` is `provider/id`, or
// UNRESOLVED_MODEL when the worker never reported the model it ran.
export interface WorkerProvenance {
  workerId: string;
  sessionId: string;
  pid: number | null;
  generation: number;
  worktree: string;
  model: string;
  thinking?: string;
  role?: string;
}

export const UNRESOLVED_MODEL = 'unresolved';

export interface ApprovalRecord {
  approvalId: string;
}

export interface EscalationRecord {
  reason: string;
}

export interface ResultMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  latencyMs: number;
  wallMs: number;
  costUsd?: number;
}

export interface AgentResult {
  status: ResultStatus;
  summary: string;
  filesChanged: string[];
  tests?: TestResult[];
  findings?: string[];
  artifacts?: ArtifactRef[];
  diff?: WorkspaceDiffRef;
  provenance: WorkerProvenance;
  approvals?: ApprovalRecord[];
  escalations?: EscalationRecord[];
  metrics: ResultMetrics;
  error?: ResultError;
}

// Closed-world field coverage: adding or removing an AgentResult field breaks
// compilation here, so the contract cannot drift from §68 silently.
export const RESULT_FIELDS = {
  status: true,
  summary: true,
  filesChanged: true,
  tests: true,
  findings: true,
  artifacts: true,
  diff: true,
  provenance: true,
  approvals: true,
  escalations: true,
  metrics: true,
  error: true,
} satisfies Record<keyof AgentResult, true>;

export type ResultValidation =
  | { valid: true; task: AgentResult }
  | { valid: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAgentResult(input: unknown): ResultValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['result must be an object'] };

  if ('transcript' in input) {
    errors.push('result must not carry a transcript (§69)');
  }
  if ('messages' in input) {
    errors.push('result must not carry messages (§69)');
  }

  if (
    typeof input.status !== 'string' ||
    !(RESULT_STATUSES as readonly string[]).includes(input.status)
  ) {
    errors.push(`status must be one of ${RESULT_STATUSES.join(', ')}`);
  }

  if (!isNonEmptyString(input.summary))
    errors.push('summary must be a non-empty string');

  if (
    !Array.isArray(input.filesChanged) ||
    input.filesChanged.some((f) => !isNonEmptyString(f))
  )
    errors.push('filesChanged must be an array of non-empty strings');

  if (!isObject(input.provenance)) {
    errors.push('provenance is required on every result, including failures');
  } else {
    const provenance = input.provenance;
    for (const field of ['workerId', 'sessionId', 'worktree', 'model']) {
      if (!isNonEmptyString(provenance[field])) {
        errors.push(`provenance.${field} must be a non-empty string`);
      }
    }
    if (
      provenance.pid !== null &&
      !(Number.isInteger(provenance.pid) && (provenance.pid as number) > 0)
    ) {
      errors.push('provenance.pid must be a positive integer or null');
    }
    if (
      !Number.isInteger(provenance.generation) ||
      (provenance.generation as number) < 0
    ) {
      errors.push('provenance.generation must be a non-negative integer');
    }
  }

  if (!isObject(input.metrics)) {
    errors.push('metrics must be present');
  } else {
    for (const field of [
      'inputTokens',
      'outputTokens',
      'cachedTokens',
      'toolCalls',
      'latencyMs',
      'wallMs',
    ]) {
      if (
        typeof input.metrics[field] !== 'number' ||
        !Number.isFinite(input.metrics[field])
      ) {
        errors.push(`metrics.${field} must be a finite number`);
      }
    }
  }

  const error = input.error;
  if (input.status === 'failed' && !isObject(error)) {
    errors.push('error is required when status is failed');
  }
  if (isObject(error)) {
    if (
      typeof error.kind !== 'string' ||
      !(ERROR_KINDS as readonly string[]).includes(error.kind)
    ) {
      errors.push(`error.kind must be one of ${ERROR_KINDS.join(', ')}`);
    }
    if (!isNonEmptyString(error.message))
      errors.push('error.message must be a non-empty string');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, task: input as unknown as AgentResult };
}

// The one §68 builder (issue #185): every producer — the lifecycle launch,
// the orchestrator's child-report reader, a failure terminus — goes
// through here, so metrics are zero-filled the same way, the closed-world
// validator runs on every result, and no transcript/messages key can slip
// in (the input shape has none). An invalid result is a bug in the caller,
// thrown as such.
export interface AgentResultInput {
  status: ResultStatus;
  summary: string;
  filesChanged?: string[];
  provenance: WorkerProvenance;
  metrics: Partial<ResultMetrics> & { wallMs: number; latencyMs: number };
  error?: ResultError;
  diff?: WorkspaceDiffRef;
  tests?: TestResult[];
  approvals?: ApprovalRecord[];
}

export function buildAgentResult(input: AgentResultInput): AgentResult {
  const built: AgentResult = {
    status: input.status,
    summary: input.summary,
    filesChanged: [...(input.filesChanged ?? [])],
    provenance: { ...input.provenance },
    metrics: {
      inputTokens: input.metrics.inputTokens ?? 0,
      outputTokens: input.metrics.outputTokens ?? 0,
      cachedTokens: input.metrics.cachedTokens ?? 0,
      toolCalls: input.metrics.toolCalls ?? 0,
      latencyMs: input.metrics.latencyMs,
      wallMs: input.metrics.wallMs,
      ...(input.metrics.costUsd === undefined
        ? {}
        : { costUsd: input.metrics.costUsd }),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.tests === undefined ? {} : { tests: input.tests }),
    ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
  };
  const validation = validateAgentResult(built);
  if (!validation.valid) {
    throw new Error(
      `worker result violates the §68 contract: ${validation.errors.join('; ')}`,
    );
  }
  return built;
}
