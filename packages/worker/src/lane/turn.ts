// The Kubic turn glue on pi-durable.
// A turn is one durably admitted input and its wait:
//
//   conversation.submit({ type: 'input', content, requestId, whenBusy })
//     → submission.wait(context)
//
// Kubic adds NO loop: durable retry/backoff is a property of the harness's
// generation task (`HarnessSettings.retry`), provider-deferred responses are
// polled inside generation, and the caller's guards (wall clock, turn count,
// SIGINT) are one cancellable Chord Context plus `conversation.abort()`
// (lane/abort.ts) on expiry. This replaces the 0.87 accept → driveToSettled →
// DriveOutcome loop (deleted from lane/solo.ts).
//
// Idempotency: `requestId` is a stable per-invocation value, so re-submitting
// after a crash returns the SAME submission instead of prompting twice.

import type { LaneImagePart } from '../../../core/src/presentation.js';
import type { ManualCompactionOutcome } from '../compaction.js';
import { runManualCompaction } from '../compaction.js';
import type { Context, Submission } from '../pi-boundary.js';
import { ConversationBusy } from '../pi-boundary.js';
import type {
  ClassifiedFailure,
  FailureCode,
  RetryDecision,
} from './failures.js';
import { chooseRetry, classifyFailure, RetryBudget } from './failures.js';
import type {
  LaneTerminalStatus,
  OperationErrorLike,
  SubmissionFailure,
} from './settle.js';
import { classifySubmissionFailure, classifyThrownError } from './settle.js';
import type { SoloLane } from './solo.js';

// `TurnOutcome.failed.reason` for the one refusal Kubic raises itself: the
// conversation is busy and the caller asked to be rejected rather than
// queued. `reject` stays the default (a submit that races a settling turn
// must fail loudly, never sit in the inbox unannounced); the TUI's busy
// Enter passes `followUp` and its steer key `steer`.
export const TURN_BUSY_REASON = 'busy';

export type TurnAbortReason = 'guard' | 'user' | 'signal';

// Failure code, or the one refusal Kubic raises itself (busy).
export type TurnFailureReason = FailureCode | typeof TURN_BUSY_REASON;

export type TurnOutcome =
  | { kind: 'completed'; submissionId: string }
  | { kind: 'failed'; reason: TurnFailureReason; error?: string }
  | { kind: 'aborted'; reason: TurnAbortReason };

// A cancelled turn's abort reason, carried on the Context's AbortSignal.
// `runTurn` classifies a cancellation from this marker; an unmarked
// cancellation is a guard (the run's own bound), and a durable
// `unanswered`/'aborted' settlement with a live context is a user abort
// (conversation.abort(), or the TUI's Esc).
export class TurnAbort extends Error {
  readonly turnAbort: TurnAbortReason;
  constructor(reason: TurnAbortReason, message: string) {
    super(message);
    this.name = 'TurnAbort';
    this.turnAbort = reason;
  }
}

export function turnAbort(reason: TurnAbortReason, message: string): TurnAbort {
  return new TurnAbort(reason, message);
}

export function turnAbortReasonOf(cause: unknown): TurnAbortReason | undefined {
  return cause instanceof TurnAbort ? cause.turnAbort : undefined;
}

// The abort reason the turn's own context carries, if it was cancelled:
// undefined for a live context. Unmarked cancellations read as a guard.
function cancelledReason(context: Context): TurnAbortReason | undefined {
  const signal = context.abortSignal;
  if (signal === undefined || !signal.aborted) return undefined;
  return turnAbortReasonOf(signal.reason) ?? 'guard';
}

export interface RunTurnOptions {
  // Stable per invocation: a re-submit with the same id finds the same
  // submission (README "Persist and Resume"), never a second prompt.
  requestId: string;
  context: Context;
  // Images attached to this prompt, in order. They are
  // admitted as Pi's own user-message content parts (`{type:'image'}`), so
  // the committed entry stores them and a resumed session replays them. No
  // images (or an empty list) keeps the plain-string content the lane has
  // always sent.
  images?: readonly LaneImagePart[];
  // Busy handling (README "Busy Conversations"): queued follow-up by
  // default, `reject` throws ConversationBusy — mapped to the named busy
  // failure below.
  whenBusy?: 'reject' | 'followUp' | 'steer';
  // The admitted submission's id and whether the harness QUEUED it
  // (a busy conversation's follow-up/steer) or PLACED it at once. The TUI's
  // busy latch follows placed work only: a queue a failed run left behind
  // waits in the inbox without a spinner (pi-durable keeps queued inputs
  // when a run faults).
  onSubmitted?: (submissionId: string, state: 'placed' | 'queued') => void;
}

// One turn, settled. Never throws for a refusal, a failed run or a cancelled
// guard: every way a durable run can end is one `TurnOutcome`.
export async function runTurn(
  solo: SoloLane,
  prompt: string,
  options: RunTurnOptions,
): Promise<TurnOutcome> {
  let submission: Submission;
  try {
    submission = await solo.conversation.submit(
      {
        type: 'input',
        content: promptContent(prompt, options.images),
        requestId: options.requestId,
        ...(options.whenBusy === undefined
          ? {}
          : { whenBusy: options.whenBusy }),
      },
      options.context,
    );
  } catch (error) {
    return submissionFailure(error, options.context);
  }
  options.onSubmitted?.(
    String(submission.id),
    await admissionState(submission, options.context),
  );
  return awaitTurn(submission, options.context);
}

// The user-message content one turn admits: the prompt as a text part
// plus one image part per attachment. Without attachments the content stays
// the bare string every existing reader (and the faux provider tests)
// expects; an image-only prompt (attach + Enter review) sends no empty
// text part at all — the image IS the message.
function promptContent(
  prompt: string,
  images: readonly LaneImagePart[] | undefined,
):
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > {
  if (images === undefined || images.length === 0) return prompt;
  return [
    ...(prompt === '' ? [] : [{ type: 'text' as const, text: prompt }]),
    ...images.map((image) => ({
      type: 'image' as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
}

// Whether the harness admitted the input as a placed entry (an idle
// conversation) or queued it in the inbox. A status read that fails
// (a closed session) reports `placed`: the run's own settlement, never a
// guess, decides what the caller sees next.
async function admissionState(
  submission: Submission,
  context: Context,
): Promise<'placed' | 'queued'> {
  try {
    const record = await submission.status(context);
    return record.status === 'queued' ? 'queued' : 'placed';
  } catch {
    return 'placed';
  }
}

// The wait half of a turn, for a submission admitted elsewhere: the durable
// settlement of an input this process did not submit (the "resume
// the pending run that carries this prompt as this run"). Same outcome
// vocabulary as runTurn.
export async function awaitTurn(
  submission: Submission,
  context: Context,
): Promise<TurnOutcome> {
  let settled: Awaited<ReturnType<Submission['wait']>>;
  try {
    settled = await submission.wait(context);
  } catch (error) {
    return submissionFailure(error, context);
  }
  if (settled.status === 'done') {
    return { kind: 'completed', submissionId: String(settled.id) };
  }
  // A cancelled context wins over the durable settlement: the guard that
  // cancelled the turn may race the `conversation.abort()` it triggered, and
  // the caller's own reason is the truthful one.
  const cancelled = cancelledReason(context);
  if (cancelled !== undefined) return { kind: 'aborted', reason: cancelled };
  if (settled.reason === 'aborted') return { kind: 'aborted', reason: 'user' };
  return failureOutcome(
    classifySubmissionFailure(settled.reason, settled.detail),
  );
}

// A throw from submit/wait: a cancelled context is the turn's own abort
// reason, anything else is a classified failure.
function submissionFailure(error: unknown, context: Context): TurnOutcome {
  const cancelled = cancelledReason(context);
  if (cancelled !== undefined) return { kind: 'aborted', reason: cancelled };
  if (error instanceof ConversationBusy) {
    return {
      kind: 'failed',
      reason: TURN_BUSY_REASON,
      error: error.message,
    };
  }
  return failureOutcome(classifyThrownError(error));
}

function failureOutcome(failure: SubmissionFailure): TurnOutcome {
  return {
    kind: 'failed',
    reason: failure.code,
    error: failure.message,
  };
}

// The lane/trajectory record for one settled turn. The `error` carries
// the failure code as `code` and the human message, the shape readers
// classify; an aborted turn records no error (its cause is the abort).
export function turnLaneRecord(outcome: TurnOutcome): {
  status: LaneTerminalStatus;
  error?: OperationErrorLike;
} {
  switch (outcome.kind) {
    case 'completed':
      return { status: 'completed' };
    case 'aborted':
      return { status: 'aborted' };
    case 'failed':
      return {
        status: 'failed',
        error: {
          code: outcome.reason,
          message: outcome.error ?? outcome.reason,
        },
      };
  }
}

// Solo context-overflow recovery. The harness owns blind retries (its durable
// generation retry), so the lane retries exactly one failure: context overflow,
// compacted first and retried once on the fresh context. Every other failure
// passes through untouched — stronger-model and new-agent decisions belong to
// and, which consume `chooseRetry`'s outcome, never this wrapper.
export interface SoloOverflowRecovery {
  outcome: TurnOutcome;
  retried: boolean;
  decision?: RetryDecision;
  compaction?: ManualCompactionOutcome;
}

export interface OverflowRecoveryOptions {
  // Product-policy budget for the retry (default: exactly one retry).
  retryBudget?: RetryBudget;
  // Reporting hook: the caller records the decision on its result and
  // trajectory/debug channel (the lane returns it too).
  onRetryDecision?: (decision: RetryDecision) => void;
}

// The focus the recovery compaction carries: the summarizer keeps what the
// single retry needs, verbatim like every manual focus.
const OVERFLOW_RECOVERY_FOCUS =
  'The context overflowed mid-run; keep what a single retry of the current task needs.';

export async function recoverSoloOverflowTurn(
  solo: SoloLane,
  prompt: string,
  failed: { reason: TurnFailureReason; error?: string },
  options: RunTurnOptions,
  recovery: OverflowRecoveryOptions = {},
): Promise<SoloOverflowRecovery> {
  const outcome: TurnOutcome = {
    kind: 'failed',
    reason: failed.reason,
    ...(failed.error === undefined ? {} : { error: failed.error }),
  };
  if (failed.reason !== 'context_overflow') return { outcome, retried: false };
  const classified: ClassifiedFailure = classifyFailure(
    'context',
    failed.reason,
    failed.error ?? failed.reason,
  );
  const budget = recovery.retryBudget ?? new RetryBudget(1);
  // The lane threads no measured spend ({}), so the maxCostUsd arm never
  // binds here — correct for a single bounded retry; widening this site
  // needs the usage plumbing first.
  const decision = chooseRetry(classified, {}, budget);
  recovery.onRetryDecision?.(decision);
  if (decision.decision !== 'retry_with_new_context')
    return { outcome, retried: false, decision };
  // A compaction that did not cut (failed, aborted, orphaned, faulted)
  // leaves the context that overflowed in place: retrying on it would
  // re-overflow, so the run abandons with the original failure. `nothing`
  // still retries — the overflow was already absorbed (background cut) and
  // the context now fits.
  const compaction = await runManualCompaction(
    solo,
    OVERFLOW_RECOVERY_FOCUS,
    options.context,
  );
  if (compaction.status !== 'completed' && compaction.status !== 'nothing') {
    return { outcome, retried: false, decision, compaction };
  }
  // A fresh request id: re-submitting the original would find the SAME
  // submission (per-invocation idempotency, above), never a new turn.
  const retried = await runTurn(solo, prompt, {
    ...options,
    requestId: `${options.requestId}:overflow-retry`,
  });
  return { outcome: retried, retried: true, decision, compaction };
}

// One turn with overflow recovery: a completed or non-overflow outcome
// passes through exactly as `runTurn` reports it.
export async function runTurnWithOverflowRecovery(
  solo: SoloLane,
  prompt: string,
  options: RunTurnOptions & OverflowRecoveryOptions,
): Promise<SoloOverflowRecovery> {
  const outcome = await runTurn(solo, prompt, options);
  if (outcome.kind !== 'failed' || outcome.reason !== 'context_overflow')
    return { outcome, retried: false };
  const { retryBudget, onRetryDecision } = options;
  return recoverSoloOverflowTurn(solo, prompt, outcome, options, {
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(onRetryDecision === undefined ? {} : { onRetryDecision }),
  });
}
