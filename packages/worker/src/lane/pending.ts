// Pending work on re-attach (issue #147, EPIC K #396; §21, §20.7).
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
//   carrying its committed output (K3 #393 never-replay semantics).
// - `abort` durably stops the work (`conversation.abort(context)`), drains
//   the lane's kill registry (D1: the bash group is keyed by the
//   conversation id) and confirms the conversation is idle.
//
// A resume that cannot settle — the guard fired, the wait failed — falls
// back to the abort, so the lane is always free for the next prompt
// afterwards.
//
// The decisions are driven by the pi-durable Harness only; the parameter is
// the structural subset of #394's SoloLane (built in parallel), so this
// module lands and compiles before that issue does.

import type {
  Context,
  Conversation,
  Harness,
  Storage,
} from '../pi-boundary.js';
import type { OperationKillRegistry } from './abort.js';

export type PendingPolicy = 'resume' | 'abort';

// Pick<SoloLane, 'harness' | 'conversation' | 'kills'> — structural, so the
// tests and the solo lane both satisfy it.
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
}

export interface SettlePendingOptions {
  readonly context: Context;
  readonly kills: OperationKillRegistry;
  // Bounds the resume wait (headless turn/wall-clock guards). Callers derive
  // it from their own context, so cancelling the run stops the wait too.
  readonly guard?: Context;
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
  solo: PendingLane,
  context: Context,
): Promise<PendingReport> {
  return reportInspection(await solo.harness.inspect(context));
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
  solo: PendingLane,
  policy: PendingPolicy,
  opts: SettlePendingOptions,
): Promise<PendingSettlementResult> {
  const inspection = await solo.harness.inspect(opts.context);
  if (!reportInspection(inspection).pending) {
    return { outcome: 'none', fellBack: false };
  }
  if (policy === 'abort') {
    await abortPending(solo, opts);
    return { outcome: 'aborted', fellBack: false };
  }
  solo.harness.resume();
  try {
    await resumePending(solo, inspection, opts);
  } catch {
    await abortPending(solo, opts);
    return { outcome: 'aborted', fellBack: true };
  }
  return { outcome: 'resumed', fellBack: false };
}

async function resumePending(
  solo: PendingLane,
  inspection: HarnessInspection,
  opts: SettlePendingOptions,
): Promise<void> {
  const bound = opts.guard ?? opts.context;
  const pending: readonly SubmissionRecord[] = inspection.submissions.filter(
    (submission) =>
      submission.type === 'input' &&
      (submission.status === 'queued' || submission.status === 'placed'),
  );
  for (const record of pending) {
    const submission = await solo.harness.submission(record.id, opts.context);
    if (submission !== undefined) await submission.wait(bound);
  }
  // Confirm the lane is free when no input carried the work (a compaction
  // task, a stray task) or a submission resolved before its tasks drained.
  await solo.conversation.waitForIdle(bound);
}

async function abortPending(
  solo: PendingLane,
  opts: SettlePendingOptions,
): Promise<void> {
  // Start the durable abort first (mark, signal, join); the kill drain then
  // unblocks a process that ignores cancellation, and awaiting the abort
  // joins every task it marked.
  const aborting = solo.conversation.abort(opts.context);
  const failures = drainKills(opts.kills, String(solo.conversation.id));
  await aborting;
  await solo.conversation.waitForIdle(opts.context);
  if (failures.length > 0) {
    throw new Error(`lane abort kills failed: ${failures.join('; ')}`);
  }
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
  const verb =
    settlement.outcome === 'resumed'
      ? 'resumed after an interrupted run'
      : 'aborted after an interrupted run';
  return settlement.fellBack
    ? `${head} ${verb} (resume could not settle)`
    : `${head} ${verb}`;
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
