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

export interface WorkerProvenance {
  workerId: string;
}

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
  } else if (!isNonEmptyString(input.provenance.workerId)) {
    errors.push('provenance.workerId must be a non-empty string');
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
