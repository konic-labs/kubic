// Settlement mapping: a settled pi-durable submission → Kubic's result
// vocabulary. Pure functions: the lane reports HOW the run ended, and this
// module translates that into a ResultStatus + ResultError and the failure
// codes of lane/failures.ts.

import type { SettledSubmissionRecord } from '../pi-boundary.js';
import { classifyFailure, type FailureCode } from './failures.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// How a run ended.
export type ResultStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'turn_limit';

// The domain a failure belongs to.
export type ResultErrorKind =
  | 'model'
  | 'provider'
  | 'tool'
  | 'process'
  | 'workspace'
  | 'context'
  | 'limit'
  | 'approval';

export interface ResultError {
  kind: ResultErrorKind;
  message: string;
  details?: JsonValue;
}

export interface OperationErrorLike {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface SettledResult {
  status: ResultStatus;
  error?: ResultError;
}

// Kubic's terminal vocabulary for a settled turn (was Pi 0.87's
// `TerminalStatus`, removed in Pi 1.0). 'completed' is a durable `done`
// answer, 'failed' an `unanswered` settlement with a reason, and 'aborted' the
// durable `unanswered`/'aborted' settlement or the conversation abort.
export type LaneTerminalStatus = 'completed' | 'failed' | 'aborted';

// One failed settlement in both vocabularies: the failure code the lifecycle
// retries on, the ResultError a result carries, and the human message.
export interface SubmissionFailure {
  code: FailureCode;
  error: ResultError;
  message: string;
}

const KIND_BY_KEYWORD: Array<{ pattern: RegExp; kind: ResultErrorKind }> = [
  { pattern: /context|overflow|too many tokens|token limit/i, kind: 'context' },
  { pattern: /approv/i, kind: 'approval' },
  { pattern: /model/i, kind: 'model' },
  {
    pattern: /provider|api|auth|network|fetch|econn|unavailable/i,
    kind: 'provider',
  },
  { pattern: /tool/i, kind: 'tool' },
  {
    pattern: /workspace|worktree|directory|file not found|enoent/i,
    kind: 'workspace',
  },
];

export function classifyHarnessError(
  code: string,
  message: string,
  details?: JsonValue,
): ResultError {
  const kind = errorKindOf(code, message);
  // Solo lane, unrecognized terminal code: the failure came from the
  // execution substrate, not from a classified domain, and the code stays in
  // the message so a diagnosis never loses it. Pinned by test.
  const text = kind === 'process' ? `${code}: ${message}` : message;
  return details === undefined
    ? { kind, message: text }
    : { kind, message: text, details };
}

function errorKindOf(code: string, message: string): ResultErrorKind {
  const haystack = `${code} ${message}`;
  for (const { pattern, kind } of KIND_BY_KEYWORD) {
    if (pattern.test(haystack)) return kind;
  }
  return 'process';
}

// The durable `unanswered` reasons pi-durable settles with (harness/
// generation.ts, harness/inbox.ts, harness/submissions.ts) and the Kubic
// error domain each belongs to. An unknown reason is a substrate failure.
const KIND_BY_SUBMISSION_REASON: Record<string, ResultErrorKind> = {
  model_error: 'model',
  no_model: 'provider',
  faulted: 'process',
  stale: 'process',
  reset: 'process',
  aborted: 'process',
};

// Reasons whose failure code the keyword classifier cannot derive: a missing
// model is a setup failure, and retrying it unchanged can never succeed
// (provider_auth carries that remedy).
const CODE_BY_SUBMISSION_REASON: Record<string, FailureCode> = {
  no_model: 'provider_auth',
};

function detailText(detail: JsonValue | undefined): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail === '' ? undefined : detail;
  return JSON.stringify(detail);
}

// One `unanswered` settlement (a durable reason, plus the harness's own
// detail when it carried one) as Kubic's vocabulary. The human message
// is the harness detail when present — never a bare reason code.
export function classifySubmissionFailure(
  reason: string,
  detail?: JsonValue,
): SubmissionFailure {
  const message = detailText(detail) ?? `lane settled ${reason}`;
  const kind = KIND_BY_SUBMISSION_REASON[reason] ?? 'process';
  const classified = classifyFailure(kind, reason, message);
  return {
    code: CODE_BY_SUBMISSION_REASON[reason] ?? classified.code,
    message,
    error: {
      kind,
      message,
      ...(detail === undefined ? {} : { details: detail }),
    },
  };
}

// A throw from submit/wait (a provider failure the harness surfaced as an
// error, a closed harness, a programming error) as the same vocabulary: the
// message is the Error's own, so the report never invents a detail.
export function classifyThrownError(error: unknown): SubmissionFailure {
  const code = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const kind = errorKindOf(code, message);
  const classified = classifyFailure(kind, code, message);
  return { code: classified.code, message, error: { kind, message } };
}

// The trajectory/lane record for one settled submission: `done` is 'completed';
// `unanswered`/aborted is 'aborted' (no error) and every other reason is
// 'failed' with the raw reason as `code` (the failure code lives on the
// TurnOutcome).
export function laneStatusOf(
  settled: SettledSubmissionRecord,
): LaneTerminalStatus {
  if (settled.status === 'done') return 'completed';
  return settled.reason === 'aborted' ? 'aborted' : 'failed';
}

export function laneErrorOf(
  settled: SettledSubmissionRecord,
): OperationErrorLike | undefined {
  if (settled.status === 'done') return undefined;
  if (settled.reason === 'aborted') return undefined;
  return {
    code: settled.reason,
    message: detailText(settled.detail) ?? settled.reason,
    ...(settled.detail === undefined ? {} : { details: settled.detail }),
  };
}

export function settleTerminalStatus(
  status: LaneTerminalStatus,
  error?: OperationErrorLike,
): SettledResult {
  switch (status) {
    case 'completed': {
      return { status: 'completed' };
    }
    case 'failed': {
      if (error === undefined) return { status: 'failed' };
      return {
        status: 'failed',
        error: classifyHarnessError(error.code, error.message, error.details),
      };
    }
    case 'aborted': {
      if (error === undefined) return { status: 'cancelled' };
      return {
        status: 'cancelled',
        error: classifyHarnessError(error.code, error.message, error.details),
      };
    }
  }
}

export function settleSubmission(
  settled: SettledSubmissionRecord,
): SettledResult {
  return settleTerminalStatus(laneStatusOf(settled), laneErrorOf(settled));
}
