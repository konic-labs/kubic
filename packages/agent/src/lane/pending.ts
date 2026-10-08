// Pending work on re-attach.
//
// A process that dies mid-turn (SIGKILL, OOM, power loss, orphan reaping)
// leaves its durable work unfinished: the reopened Harness restores every
// live task as pending and holds the placed submission until the scheduler
// runs again. `harness.inspect()` reports that work without resuming it;
// this module is the one place Kubic decides what happens to it:
//
// - `resume` enables the scheduler (`harness.resume()`), then waits under
//   the caller's bound — for the placed input submissions, and for the
//   conversation to go idle. An `unsafe` tool interrupted mid-call is not
//   re-executed: pi-durable settles it with an `interrupted` error result
//   carrying its committed output (never-replay semantics). The
//   durable settlement is reported (`settled` + `reason`), so a run that
//   ended `unanswered` is never named a clean resume.
// - work a dead process had already marked aborted is aborted, never
//   started: the mark is durable, and honours the operator's cancel.
// - `abort` durably stops the work (`conversation.abort(context)`), drains
//   the lane's kill registry (the bash group is keyed by the conversation id)
//   and confirms the conversation is idle.
//
// A resume that cannot settle — the guard was already exhausted, the wait
// failed — falls back to the abort on a FRESH context (`abortContext`,
// defaulting to BACKGROUND_CONTEXT). The context that failed the resume is
// cancelled by definition, and pi-durable rejects a commit on a cancelled
// context, which would leave the interrupted turn running. The lane is
// always free for the next prompt afterwards.
//
// The decisions are driven by the pi-durable Harness only; the parameter is
// the structural subset of the Lane (built in parallel), so this
// module lands and compiles before that issue does.

import {
  BACKGROUND_CONTEXT,
  type Context,
  type Conversation,
  type EntryRecord,
  type Harness,
  type Storage,
} from '../pi-boundary.js';
import type { OperationKillRegistry } from './abort.js';

export type PendingPolicy = 'resume' | 'abort';

// Pick<Lane, 'harness' | 'conversation' | 'kills'> — structural, so the
// tests and the lane both satisfy it.
export interface PendingLane {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly kills: OperationKillRegistry;
}

export interface PendingReport {
  readonly pending: boolean;
  readonly summary?: string;
}

export interface PendingSettlementResult {
  readonly outcome: 'resumed' | 'aborted' | 'none';
  readonly fellBack: boolean;
  // How the resumed work durably ended; absent when Kubic aborted it.
  readonly settled?: 'done' | 'unanswered';
  // The durable settlement reason (`unanswered`), or the failure that
  // forced the fallback abort. Absent for a clean resume.
  readonly reason?: string;
}

export interface SettlePendingOptions {
  readonly context: Context;
  readonly kills: OperationKillRegistry;
  // Bounds the resume wait (headless turn/wall-clock guards). Callers derive
  // it from their own context, so cancelling the run stops the wait too.
  readonly guard?: Context;
  // Runs the abort and the idle confirmation — never the cancelled context a
  // failed resume was stopped by. Default BACKGROUND_CONTEXT; pass a bounded
  // context to cap the cleanup.
  readonly abortContext?: Context;
}

type HarnessInspection = Awaited<ReturnType<Harness['inspect']>>;
type SubmissionRecord = HarnessInspection['submissions'][number];

// One page is enough for a session's live work; a scan that fills it is
// already far beyond anything a lane can be carrying.
const STORED_WORK_LIMIT = 100;
const UNFINISHED_TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completing',
] as const;
const UNFINISHED_SUBMISSION_STATUSES = ['queued', 'placed'] as const;

export async function inspectPending(
  lane: PendingLane,
  context: Context,
): Promise<PendingReport> {
  return reportInspection(await lane.harness.inspect(context));
}

function reportInspection(inspection: HarnessInspection): PendingReport {
  if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
    return { pending: false };
  }
  const parts = [
    ...inspection.tasks.map(
      (task) => `${task.record.kind} ${task.record.id} (${task.state.kind})`,
    ),
    ...inspection.submissions.map(
      (submission) => `submission ${submission.id} (${submission.status})`,
    ),
  ];
  return { pending: true, summary: `pending work: ${parts.join(', ')}` };
}

export async function settlePending(
  lane: PendingLane,
  policy: PendingPolicy,
  opts: SettlePendingOptions,
): Promise<PendingSettlementResult> {
  const inspection = await lane.harness.inspect(opts.context);
  if (!reportInspection(inspection).pending) {
    return { outcome: 'none', fellBack: false };
  }
  // An abort the dead process already requested stays an abort: the durable
  // mark is the operator's cancel, so the
  // interrupted run is never started for it.
  if (policy === 'abort' || abortedPending(inspection)) {
    await abortPending(lane, opts);
    return { outcome: 'aborted', fellBack: false };
  }
  const bound = opts.guard ?? opts.context;
  const exhaustion = exhausted(bound);
  if (exhaustion !== undefined) {
    // Never start a paid generation the guard would abandon at once.
    await abortPending(lane, opts);
    return { outcome: 'aborted', fellBack: true, reason: exhaustion };
  }
  lane.harness.resume();
  let settled: ResumedSettlement;
  try {
    settled = await resumePending(lane, inspection, opts, bound);
  } catch (error) {
    await abortPending(lane, opts);
    return { outcome: 'aborted', fellBack: true, reason: failureText(error) };
  }
  if (settled.status === undefined) {
    return { outcome: 'resumed', fellBack: false };
  }
  if (settled.reason === undefined) {
    return { outcome: 'resumed', fellBack: false, settled: settled.status };
  }
  return {
    outcome: 'resumed',
    fellBack: false,
    settled: settled.status,
    reason: settled.reason,
  };
}

interface ResumedSettlement {
  status?: 'done' | 'unanswered';
  reason?: string;
}

async function resumePending(
  lane: PendingLane,
  inspection: HarnessInspection,
  opts: SettlePendingOptions,
  bound: Context,
): Promise<ResumedSettlement> {
  const pending: readonly SubmissionRecord[] = inspection.submissions.filter(
    (submission) =>
      submission.type === 'input' &&
      (submission.status === 'queued' || submission.status === 'placed'),
  );
  let settlement: ResumedSettlement = {};
  for (const record of pending) {
    const submission = await lane.harness.submission(record.id, opts.context);
    if (submission === undefined) continue;
    const settled = await submission.wait(bound);
    if (settled.status === 'unanswered') {
      if (settlement.status !== 'unanswered') {
        settlement = { status: 'unanswered', reason: settled.reason };
      }
    } else if (settlement.status === undefined) {
      settlement = { status: 'done' };
    }
  }
  // Confirm the lane is free when no input carried the work (a compaction
  // task, a stray task) or a submission resolved before its tasks drained.
  await lane.conversation.waitForIdle(bound);
  return settlement;
}

async function abortPending(
  lane: PendingLane,
  opts: SettlePendingOptions,
): Promise<void> {
  // The abort must commit: a context cancelled by the failed resume would be
  // rejected by pi-durable and leave the interrupted turn running.
  const abortContext = opts.abortContext ?? BACKGROUND_CONTEXT;
  // Start the durable abort first (mark, signal, join); the kill drain then
  // unblocks a process that ignores cancellation, and awaiting the abort
  // joins every task it marked.
  const aborting = lane.conversation.abort(abortContext);
  const failures = drainKills(opts.kills, String(lane.conversation.id));
  try {
    await aborting;
    await lane.conversation.waitForIdle(abortContext);
  } catch (error) {
    const abortFailure = `lane abort failed: ${failureText(error) ?? 'unknown error'}`;
    throw failures.length === 0
      ? new Error(abortFailure)
      : new Error(`${abortFailure}; kills failed: ${failures.join('; ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`lane abort kills failed: ${failures.join('; ')}`);
  }
}

function abortedPending(inspection: HarnessInspection): boolean {
  return inspection.tasks.some((task) => task.record.abortRequested === true);
}

function exhausted(bound: Context): string | undefined {
  const signal = bound.abortSignal;
  if (signal === undefined || !signal.aborted) return undefined;
  return failureText(signal.reason) ?? 'the resume bound was already exhausted';
}

function failureText(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(cause);
}

function drainKills(
  kills: OperationKillRegistry,
  operationId: string,
): string[] {
  const failures: string[] = [];
  for (const kill of kills.drain(operationId)) {
    try {
      kill();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

// The one-line notice `kubic run` (stderr) and the TUI (footer) print for
// the pending work `inspectPending` reported.
export function describePendingSettlement(
  summary: string | undefined,
  settlement: PendingSettlementResult,
): string {
  if (settlement.outcome === 'none') return 'no pending work to settle';
  const head = summary ?? 'pending work';
  if (settlement.outcome === 'resumed') {
    if (settlement.settled === undefined) {
      return `${head} resumed after an interrupted run`;
    }
    const detail =
      settlement.reason === undefined
        ? settlement.settled
        : `${settlement.settled} (${settlement.reason})`;
    return `${head} resumed after an interrupted run: ${detail}`;
  }
  if (!settlement.fellBack) {
    return `${head} aborted after an interrupted run`;
  }
  const cause = settlement.reason === undefined ? '' : `: ${settlement.reason}`;
  return `${head} aborted after an interrupted run (resume could not settle${cause})`;
}

// 's "the pending run carries this very prompt: resume it as this run,
// never re-prompt" decision needs the text the dead process admitted. The
// placed input submission's own entry is that text; undefined when nothing
// is placed (nothing to resume-as-this-run).
export async function pendingInputText(
  lane: PendingLane,
  context: Context,
): Promise<string | undefined> {
  const inspection = await lane.harness.inspect(context);
  const placed = inspection.submissions.find(
    (submission) =>
      submission.type === 'input' && submission.status === 'placed',
  );
  if (placed?.entry === undefined) return undefined;
  const page = await lane.conversation.entries(
    { minEntryId: placed.entry, maxEntryId: placed.entry },
    1,
    undefined,
    context,
  );
  return userText(page.items[0]);
}

function userText(entry: EntryRecord | undefined): string | undefined {
  const message = entry?.model?.[0];
  if (message === undefined || message.role !== 'user') return undefined;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

// Read-only probe for `kubic sessions attach`: reports unfinished work
// straight from a session's storage, without opening a Harness (which would
// move running tasks back to pending) or acquiring the lane.
export async function inspectStoredWork(
  storage: Storage,
  context: Context,
): Promise<PendingReport> {
  const parts: string[] = [];
  for (const status of UNFINISHED_TASK_STATUSES) {
    const page = await storage.scanTasks(
      { status },
      STORED_WORK_LIMIT,
      undefined,
      context,
    );
    for (const task of page.items) {
      parts.push(`${task.kind} ${task.id} (${task.state.status})`);
    }
  }
  for (const status of UNFINISHED_SUBMISSION_STATUSES) {
    const page = await storage.scanSubmissions(
      { status },
      STORED_WORK_LIMIT,
      undefined,
      context,
    );
    for (const submission of page.items) {
      parts.push(`submission ${submission.id} (${submission.status})`);
    }
  }
  if (parts.length === 0) return { pending: false };
  return { pending: true, summary: `pending work: ${parts.join(', ')}` };
}
