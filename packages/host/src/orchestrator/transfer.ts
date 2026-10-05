// Context transfer and handoff (issue #184): the §24 TaskTransfer record,
// the §25.2 TaskArtifact carried on a worker result, and the §25.3/§69
// Handoff with its no-transcript guarantee.
//
// These are LIVE modules, not resurrections: the run itself is the
// consumer (prompt composition, run state, `--json`), so the #99 pin
// stays intact — `packages/agents/src/{artifacts,transfer}.ts` and
// `packages/host/src/handoff.ts` stay deleted and are never imported.
import type { AgentResult } from '../../../worker/src/result.js';

/** A refusal the run acts on: a stable code plus the reason. */
export class TransferRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TransferRejectedError';
    this.code = code;
  }
}

// §69 shapes: anything message-history-shaped must never reach a worker
// prompt. Only OBJECTS are inspected — plain strings (even ones naming
// roles, like "the user role needs a check") pass untouched.
const MESSAGE_ROLES = new Set([
  'user',
  'assistant',
  'system',
  'tool',
  'function',
]);

function isHistoryShaped(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isHistoryShaped);
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if ('messages' in entry || 'transcript' in entry) return true;
  if (
    typeof entry.role === 'string' &&
    MESSAGE_ROLES.has(entry.role) &&
    ('content' in entry || 'parts' in entry || 'text' in entry)
  ) {
    return true;
  }
  return Object.values(entry).some(isHistoryShaped);
}

/**
 * The §69 gate: reject message-history-shaped content before it can be
 * stored in a transfer, rendered into a prompt, or surfaced in `--json`.
 * Throws TransferRejectedError naming where the shape was found.
 */
export function assertNoTranscript(value: unknown, where: string): void {
  if (isHistoryShaped(value)) {
    throw new TransferRejectedError(
      'message_history',
      `${where} carries message-history-shaped content (§69): refs and summaries only, never transcripts`,
    );
  }
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  );
}

/** §25.2 TaskArtifact: the structured result a handoff carries. JSON-safe. */
export interface TaskArtifact {
  summary: string;
  fileRefs: string[];
  findings: string[];
  testResults: Array<{ name: string; passed: boolean; output?: string }>;
  /**
   * §68 carries no decision list, so this starts empty — reserved for the
   * §70 loop consumer, which is out of scope for #184.
   */
  decisions: string[];
  /** The diff ref (§25.3): the branch (or diff id) holding the change. */
  diffRef?: string;
  worktree: string;
}

/**
 * Build the artifact from a settled §68 result: refs and summaries only.
 * Every copied field passes the §69 gate — a result smuggling message
 * history in a free-text field is rejected, never stored.
 */
export function artifactFromResult(
  agentId: string,
  result: AgentResult,
  opts: { worktree: string; diffRef?: string },
): TaskArtifact {
  const findings = result.findings ?? [];
  const testResults = (result.tests ?? []).map((test) => ({
    name: test.name,
    passed: test.passed,
    ...(test.output === undefined ? {} : { output: test.output }),
  }));
  const artifact: TaskArtifact = {
    summary: result.summary,
    fileRefs: [...result.filesChanged],
    findings: [...findings],
    testResults,
    decisions: [],
    ...(result.diff === undefined && opts.diffRef === undefined
      ? {}
      : { diffRef: opts.diffRef ?? result.diff?.diffId ?? '' }),
    worktree: opts.worktree,
  };
  assertNoTranscript(artifact, `artifact for '${agentId}'`);
  if (typeof artifact.summary !== 'string' || artifact.summary.trim() === '') {
    throw new TransferRejectedError(
      'invalid_record',
      `artifact for '${agentId}' needs a non-empty summary`,
    );
  }
  if (!isStringList(artifact.fileRefs) || !isStringList(artifact.findings)) {
    throw new TransferRejectedError(
      'invalid_record',
      `artifact for '${agentId}' needs string file refs and findings`,
    );
  }
  return artifact;
}

/** §24 TaskTransfer: everything a worker is handed beyond its step. */
export interface TaskTransfer {
  task: string;
  worktree: string;
  relevantFiles: string[];
  constraints: string[];
  previousFindings: string[];
  expectedOutput: string;
  budget?: Record<string, number>;
}

export interface TaskTransferInput {
  task: string;
  worktree: string;
  relevantFiles: string[];
  constraints: string[];
  expectedOutput: string;
  previousFindings?: string[];
  budget?: Record<string, number>;
}

/** Validate and default a transfer record. Previous findings fill at
 * launch (from settled artifacts); a freshly built record starts empty. */
export function buildTaskTransfer(input: TaskTransferInput): TaskTransfer {
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new TransferRejectedError(
      'invalid_record',
      'task must be a non-empty string',
    );
  }
  for (const [field, value] of [
    ['relevantFiles', input.relevantFiles],
    ['constraints', input.constraints],
  ] as const) {
    if (!isStringList(value)) {
      throw new TransferRejectedError(
        'invalid_record',
        `${field} must be an array of strings`,
      );
    }
  }
  if (
    typeof input.expectedOutput !== 'string' ||
    input.expectedOutput.trim() === ''
  ) {
    throw new TransferRejectedError(
      'invalid_record',
      'expectedOutput must be a non-empty string',
    );
  }
  const previousFindings = input.previousFindings ?? [];
  if (!isStringList(previousFindings)) {
    throw new TransferRejectedError(
      'invalid_record',
      'previousFindings must be an array of strings',
    );
  }
  const transfer: TaskTransfer = {
    task: input.task,
    worktree: input.worktree,
    relevantFiles: [...input.relevantFiles],
    constraints: [...input.constraints],
    previousFindings: [...previousFindings],
    expectedOutput: input.expectedOutput,
    ...(input.budget === undefined ? {} : { budget: { ...input.budget } }),
  };
  assertNoTranscript(transfer, 'task transfer');
  return transfer;
}

/**
 * Render a transfer deterministically into prompt text: fixed section
 * order, fixed labels, no model-generated prose. The same record always
 * renders the same text.
 */
export function renderTransferRecord(transfer: TaskTransfer): string {
  const lines = [
    `Task: ${transfer.task}`,
    `Worktree: ${transfer.worktree}`,
    `Relevant files: ${transfer.relevantFiles.join(', ') || '(none)'}`,
    `Constraints: ${transfer.constraints.join('; ') || '(none)'}`,
    `Expected output: ${transfer.expectedOutput}`,
  ];
  if (transfer.previousFindings.length > 0) {
    lines.push(
      'Previous findings:',
      ...transfer.previousFindings.map((finding) => `- ${finding}`),
    );
  }
  return lines.join('\n');
}
