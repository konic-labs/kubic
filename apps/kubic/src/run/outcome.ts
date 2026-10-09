// How a `kubic run` stopped, and the result each stop maps to. The phases
// report a RunStop; `runResult` is the one place a stop becomes a terminus
// (and so an exit code).
import type {
  ClassifiedFailure,
  RetryDecision,
} from '@kubic/agent/lane/failures';
import type { TurnAbortReason, TurnOutcome } from '@kubic/agent/lane/turn';
import {
  type InstalledPolicy,
  TIMEOUT_REASON_MARKER,
} from '@kubic/host/approvals';
import {
  caughtRunResult,
  type HeadlessRunResult,
  mapLaneOutcomeToFailure,
  type RetryRecord,
} from '@kubic/host/run';
import type { BootRefusal } from '../session/bootstrap.js';
import { type GuardStop, guardStopMessage } from './guard.js';
import { NO_ASSISTANT_TEXT_SUMMARY } from './output.js';

export type RunStop =
  // The request itself is invalid (exit 2), before any session exists.
  | { readonly kind: 'usage'; readonly message: string }
  // A failure the run caught rather than settled.
  | { readonly kind: 'caught'; readonly error: unknown }
  // The boot stopped before the lane existed.
  | { readonly kind: 'refused'; readonly refusal: BootRefusal }
  // A guard stopped the run's waits.
  | GuardStop
  // The lane aborted its turn with no guard behind it.
  | { readonly kind: 'aborted'; readonly reason: TurnAbortReason }
  // The installed policy refused an approval during the turn.
  | {
      readonly kind: 'denied';
      readonly denials: ReturnType<InstalledPolicy['denials']>;
    }
  // The turn settled; `summary` is the final assistant text, if any.
  | {
      readonly kind: 'completed';
      readonly summary: string | undefined;
      readonly retry?: RetryRecord;
    }
  | {
      readonly kind: 'failed';
      readonly outcome: Extract<TurnOutcome, { kind: 'failed' }>;
      readonly retry?: RetryRecord;
    };

// The result for a stop. `sessionId` is the session the run opened; a run
// that never opened one reports `unassigned`.
export function runResult(
  stop: RunStop,
  sessionId?: string,
): HeadlessRunResult {
  const id = sessionId ?? 'unassigned';
  switch (stop.kind) {
    case 'usage':
      return finished(id, 'usage', stop.message, stop.message);
    case 'caught':
      return caughtRunResult(sessionId, stop.error);
    case 'refused':
      return refusedResult(id, stop.refusal);
    case 'interrupted':
    case 'timeout':
    case 'turn-limit':
      return guardResult(id, stop);
    case 'aborted': {
      const message =
        stop.reason === 'user'
          ? 'lane aborted before it settled'
          : 'run guard exhausted';
      return finished(
        id,
        stop.reason === 'user' ? 'failed' : 'turn_limit',
        message,
        message,
      );
    }
    case 'denied':
      return deniedResult(id, stop.denials);
    case 'completed':
      return finished(
        id,
        'completed',
        stop.summary ?? NO_ASSISTANT_TEXT_SUMMARY,
        undefined,
        undefined,
        undefined,
        stop.retry,
      );
    case 'failed': {
      // The failure code and its message go through the same settlement
      // kernel the lane record does, so approval/workspace/provider
      // failures keep their 4/5/6 classes and the precise code rides
      // beside the terminus.
      const message = stop.outcome.error ?? stop.outcome.reason;
      const { terminus, failure } = mapLaneOutcomeToFailure('failed', {
        code: stop.outcome.reason,
        message,
      });
      return finished(
        id,
        terminus,
        `${stop.outcome.reason}: ${message}`,
        message,
        undefined,
        failure,
        stop.retry,
      );
    }
  }
}

// The envelope record carries whether the retry
// happened, so --json distinguishes retried-then-failed (retried: true)
// from decided-to-retry-but-compaction-refused and abandoned
// (retried: false). Absent when the lane made no decision.
export function retryRecord(
  decision: RetryDecision | undefined,
  retried: boolean,
): RetryRecord | undefined {
  if (decision === undefined) return undefined;
  return { ...decision, retried };
}

function refs(
  id: string,
): Pick<HeadlessRunResult, 'journalRef' | 'usageRef' | 'trajectoryRef'> {
  return {
    journalRef: `journal:${id}`,
    usageRef: `usage:${id}`,
    trajectoryRef: `trajectory:${id}`,
  };
}

function finished(
  id: string,
  terminus: HeadlessRunResult['terminus'],
  summary: string,
  errorMessage?: string,
  signal?: string,
  failure?: ClassifiedFailure,
  // The retry decision when the lane made one (overflow
  // recovery) — strategy, reason, notBefore and whether the retry
  // happened, also on success.
  retry?: RetryRecord,
): HeadlessRunResult {
  return {
    terminus,
    summary,
    sessionId: id,
    ...refs(id),
    ...(signal === undefined ? {} : { signal }),
    ...(failure === undefined ? {} : { failure }),
    ...(retry === undefined ? {} : { retry }),
    ...(errorMessage === undefined
      ? {}
      : { error: { kind: terminus, message: errorMessage } }),
  };
}

// A boot that stopped before the lane: no usable model is the provider
// probe's code (exit 6), every other refusal a failure.
function refusedResult(id: string, refusal: BootRefusal): HeadlessRunResult {
  if (refusal.kind === 'cancelled')
    return finished(id, 'cancelled', 'cancelled');
  const message =
    refusal.kind === 'store' ? String(refusal.error) : refusal.message;
  return finished(
    id,
    refusal.kind === 'provider' ? 'provider_probe_failed' : 'failed',
    message,
    message,
  );
}

// A guard that stopped the run before or instead of a settlement: an
// interrupt is `cancelled` (128+signo), a wall-clock bound is `timeout`
// (exit 1), and `--max-turns` is `turn_limit` (exit 3).
function guardResult(id: string, stop: GuardStop): HeadlessRunResult {
  const message = guardStopMessage(stop);
  switch (stop.kind) {
    case 'interrupted':
      return finished(id, 'cancelled', message, message, stop.signal);
    case 'timeout':
      return finished(id, 'timeout', message, message);
    case 'turn-limit':
      return finished(id, 'turn_limit', message, message);
  }
}

// The installed policy refused an approval. The block reaches
// the model as a tool error, so the lane settles `completed` — but a
// dangerous operation the user never approved did NOT happen, and
// reporting exit 0 would be the dishonest half of the problem. A run whose
// policy denied an approval maps to the approval terminus (exit 4) with the
// refusal named; a denial OUTRANKS a settled turn.
//
// Exit 4 covers the whole approval terminus; the STATUS is
// the honest half. A denial whose reason carries the timeout marker is
// a bound that elapsed, everything else is a refusal — a script can
// tell "the operator said no" from "nobody answered in time".
// Classification keys off the one TIMEOUT_REASON_MARKER string (the
// same one classifyVerdict uses) rather than a private regex that could
// drift from the producers. It reads the first recorded denial's reason.
function deniedResult(
  id: string,
  denials: ReturnType<InstalledPolicy['denials']>,
): HeadlessRunResult {
  const named = denials
    .map((denial) => `${denial.capability} (${denial.toolName})`)
    .join(', ');
  const first = denials[0]?.reason ?? '';
  const message = `approval refused: ${named} — ${first}`;
  const terminus = first.includes(TIMEOUT_REASON_MARKER)
    ? 'approval_timed_out'
    : 'approval_denied';
  return finished(id, terminus, message, message);
}
