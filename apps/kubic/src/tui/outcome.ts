// A settled TUI turn's footer line and the outcome its trajectory records.
import type { TranscriptItem } from '@kubic/agent/lane/transcript';
import { turnLaneRecord } from '@kubic/agent/lane/turn';
import type { RunOutcome, RunTerminusKind } from '@kubic/host/run';
import { assistantSummary, NO_ASSISTANT_TEXT_SUMMARY } from '../run/output.js';
import type { TuiTurnOutcome, TuiTurnRecord } from './types.js';

// The terminus of a durable failure: the reason code carries
// the classification the terminal-status mapping derives, so the
// TUI trajectory keeps the same envelope vocabulary as `kubic run`. A code
// this map does not know stays a plain failure — never an invented terminus.
function terminusOfFailure(reason: string): RunTerminusKind {
  switch (reason) {
    case 'approval_denied':
      return 'approval_denied';
    case 'approval_timed_out':
      return 'approval_timed_out';
    case 'workspace_failed':
      return 'workspace_unavailable';
    // A mid-run provider error is a task failure with its own
    // terminus, never the pre-run probe (`provider_probe_failed`, exit 6).
    case 'provider_transient':
      return 'provider_transient';
    case 'provider_auth':
      return 'provider_auth';
    default:
      return 'failed';
  }
}

// A settled TUI turn → the outcome its trajectory records: the
// durable turn record decides, exactly as it does for `kubic run`; a
// turn the lane never settled is a plain failure, never an invented terminus.
export function tuiTurnOutcome(
  turn: TuiTurnRecord,
  items: readonly TranscriptItem[],
): RunOutcome {
  const lane = turn.turn === undefined ? undefined : turnLaneRecord(turn.turn);
  // The lane's own record is authoritative: an abort that raced a completing
  // turn is a completed run, not a cancellation (the work really did land).
  const completed =
    lane === undefined
      ? turn.outcome.status === 'completed'
      : lane.status === 'completed';
  if (completed) {
    return {
      terminus: 'completed',
      summary: assistantSummary(items) ?? NO_ASSISTANT_TEXT_SUMMARY,
      ...(lane === undefined ? {} : { lane }),
    };
  }
  const summary = turn.outcome.detail ?? footerForOutcome(turn.outcome);
  const terminus =
    lane?.status === 'failed'
      ? terminusOfFailure(lane.error?.code ?? '')
      : 'failed';
  return { terminus, summary, ...(lane === undefined ? {} : { lane }) };
}

// One-line footer for a settled turn: the editor row is the loop's only
// always-visible status surface besides the status bar, and a silent
// outcome (especially a cancellation) would leave the user guessing.
export function footerForOutcome(outcome: TuiTurnOutcome): string {
  if (outcome.status === 'completed') return '';
  if (outcome.status === 'cancelled') return 'cancelled';
  return `error: ${outcome.detail ?? 'the turn failed'}`;
}
