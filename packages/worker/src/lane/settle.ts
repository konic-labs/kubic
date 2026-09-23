// Settlement mapping: Pi terminal records → Kubic result contract
// (issue #11, slice C). Pure functions: the lane reports HOW the run
// ended, and this module translates that into the #7 ResultStatus +
// ResultError vocabulary. Full AgentResult/Task/Handoff transitions belong
// to the lifecycle owners (#42 worker lifecycle, #52–#53 replay); this is
// the status/error kernel they build on.

import type { TerminalStatus } from '../pi-boundary.js';
import type {
  JsonValue,
  ResultError,
  ResultErrorKind,
  ResultStatus,
} from '../result.js';

export interface OperationErrorLike {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface SettledResult {
  status: ResultStatus;
  error?: ResultError;
}

const KIND_BY_KEYWORD: Array<{ pattern: RegExp; kind: ResultErrorKind }> = [
  { pattern: /budget/i, kind: 'budget' },
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
  const haystack = `${code} ${message}`;
  for (const { pattern, kind } of KIND_BY_KEYWORD) {
    if (pattern.test(haystack)) return { kind, message, details };
  }
  // Solo lane, unrecognized terminal code: the failure came from the
  // execution substrate, not from a classified domain. Pinned by test.
  return { kind: 'process', message: `${code}: ${message}`, details };
}

export function settleTerminalStatus(
  status: TerminalStatus,
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
    case 'aborted':
    case 'declined': {
      if (error === undefined) return { status: 'cancelled' };
      return {
        status: 'cancelled',
        error: classifyHarnessError(error.code, error.message, error.details),
      };
    }
  }
}
