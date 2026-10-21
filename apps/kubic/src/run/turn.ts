// The turn of a `kubic run`: a turn a dead process left open is settled
// first, then the run's prompt is driven to a settlement under the guard.
// Returns how the turn stopped; outcome.ts maps that to the terminus.
import { randomUUID } from 'node:crypto';
import type { Lane } from '@kubic/agent/lane/boot';
import {
  type KubicLaneEvent,
  subscribeLaneEvents,
} from '@kubic/agent/lane/events';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '@kubic/agent/lane/pending';
import {
  entriesToTranscript,
  readConversationEntries,
} from '@kubic/agent/lane/transcript';
import {
  awaitTurn,
  runTurnWithOverflowRecovery,
  type TurnOutcome,
  turnLaneRecord,
} from '@kubic/agent/lane/turn';
import type { InstalledPolicy } from '@kubic/host/approvals';
import type { RetryRecord } from '@kubic/host/run';
import type { SessionBoot } from '../session/bootstrap.js';
import type { RunGuard } from './guard.js';
import { type RunStop, retryRecord } from './outcome.js';
import {
  assistantSummary,
  laneActivityDebugLine,
  overflowRecoveryNotice,
} from './output.js';
import type { RunState } from './state.js';

type Submission = Awaited<ReturnType<Lane['harness']['submission']>>;

export async function runTurn(
  state: RunState,
  boot: SessionBoot,
  guard: RunGuard,
): Promise<RunStop> {
  const lane = boot.lane as Lane;
  // The turn guard: one event subscription per conversation counts
  // the run's turns for `--max-turns`. Durable retries are the harness's own
  // (they commit no assistant entry), so a turn is one committed response.
  const detachEvents = await subscribeLaneEvents(
    lane.harness,
    lane.conversation.id,
    (event) => onLaneEvent(state, guard, event),
    state.context,
  );
  try {
    if (guard.interruptedBy !== undefined) {
      return { kind: 'interrupted', signal: guard.interruptedBy };
    }
    const resumed = await acceptPending(state, lane, guard);
    const stopped = guard.stop;
    if (stopped !== undefined) {
      state.abandoned = true;
      return stopped;
    }
    const { outcome, retry } = await driveTurn(state, lane, guard, resumed);
    state.capture.lane = turnLaneRecord(outcome);
    return await settledStop(
      state,
      lane,
      boot.installed as InstalledPolicy,
      guard,
      outcome,
      retry,
    );
  } finally {
    await detachEvents();
  }
}

// A retry backoff and a compaction are named on the debug channel — tens of
// silent seconds otherwise; tool calls feed the progress sink; each
// committed response counts one turn.
function onLaneEvent(
  state: RunState,
  guard: RunGuard,
  event: KubicLaneEvent,
): void {
  const activity = laneActivityDebugLine(event);
  if (activity !== undefined) state.sinks.debug?.(activity);
  if (event.type === 'tool-start') {
    state.options.progress?.toolStart({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
    return;
  }
  if (event.type === 'tool-end') {
    if (event.isError) state.capture.tally.toolErrors += 1;
    state.options.progress?.toolEnd({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      ...(event.entry === undefined ? {} : { entry: event.entry }),
    });
    return;
  }
  if (event.type !== 'usage') return;
  const usage = event.row.usage;
  const tally = state.capture.tally;
  tally.input += usage.input;
  tally.output += usage.output;
  tally.cacheRead += usage.cacheRead;
  tally.cacheWrite += usage.cacheWrite;
  tally.costUsd += usage.cost?.total ?? 0;
  guard.countTurn(usage.cost?.total ?? 0);
}

// A turn a dead process left open would refuse this
// prompt. The documented policy: when the pending run carries this very
// prompt (a retried script), it is resumed AS this run — never
// re-prompted, and its submission is returned for the drive to await.
// Otherwise it is resumed first under the same guard and then this
// prompt is admitted; a resume that cannot settle (guard fired,
// approval with no TTY) is durably aborted. Each choice is named on
// stderr.
// Lane spans: `accept` covers admitting this run's work —
// the pending turn a dead process left, settled first — and `drive`
// covers the durable turn itself (submit → wait → settlement). Tool
// spans nest under `drive` because `startLane('drive')` is the lane
// open when the harness runs them.
async function acceptPending(
  state: RunState,
  lane: Lane,
  guard: RunGuard,
): Promise<Submission | undefined> {
  const pending = await inspectPending(lane, state.context);
  const acceptSpan = state.spans.startLane('accept');
  try {
    if (!pending.pending) return undefined;
    const pendingPrompt = await pendingInputText(lane, state.context);
    const placed = (await lane.harness.inspect(state.context)).submissions.find(
      (record) => record.type === 'input' && record.status === 'placed',
    );
    if (
      pendingPrompt !== undefined &&
      // An `--invoke-skill` retry coalesces with its
      // own pending expanded prompt (identical to `prompt` for
      // non-invoke runs).
      pendingPrompt === state.effectivePrompt &&
      placed !== undefined
    ) {
      const resumed = await lane.harness.submission(placed.id, state.context);
      state.sinks.notice(
        `${pending.summary ?? 'pending work'} carries this prompt: resuming it instead of re-prompting`,
      );
      return resumed;
    }
    const settlement = await settlePending(lane, 'resume', {
      context: state.context,
      kills: lane.kills,
      guard: guard.context,
    });
    state.sinks.notice(describePendingSettlement(pending.summary, settlement));
    return undefined;
  } finally {
    state.spans.endLane(acceptSpan, guard.stopMessage);
  }
}

// The durable turn: a resumed submission is awaited, otherwise the prompt is
// submitted. One stable request id per invocation: a re-submit inside this
// run finds the same submission instead of prompting twice, while a fresh
// invocation is a fresh prompt.
async function driveTurn(
  state: RunState,
  lane: Lane,
  guard: RunGuard,
  resumed: Submission | undefined,
): Promise<{ outcome: TurnOutcome; retry?: RetryRecord }> {
  const requestId = `kubic-run:${randomUUID()}`;
  const driveSpan = state.spans.startLane('drive');
  try {
    if (resumed !== undefined) {
      return { outcome: await awaitTurn(resumed, guard.context) };
    }
    // A context overflow compacts and retries
    // once on the fresh context; every other outcome passes through
    // exactly as runTurn reports it.
    const recovered = await runTurnWithOverflowRecovery(
      lane,
      state.effectivePrompt,
      {
        requestId,
        context: guard.context,
        // Headless refuses: a run that somehow finds the conversation busy
        // fails by name instead of queueing behind a turn nobody is
        // watching.
        whenBusy: 'reject',
        onRetryDecision: (decision) => {
          const text = overflowRecoveryNotice(decision);
          if (text !== undefined) state.sinks.notice(text);
        },
      },
    );
    // The overflow-recovery decision, when the lane made one, rides into
    // the envelope.
    const retry = retryRecord(recovered.decision, recovered.retried);
    return {
      outcome: recovered.outcome,
      ...(retry === undefined ? {} : { retry }),
    };
  } finally {
    state.spans.endLane(driveSpan, guard.stopMessage);
  }
}

// How a driven turn stopped. An aborted turn leaves the durable run live:
// the close states the abort and drains the kill registry before the sweep.
// A recorded approval refusal is checked before the settlement: a denial
// outranks a settled turn.
async function settledStop(
  state: RunState,
  lane: Lane,
  installed: InstalledPolicy,
  guard: RunGuard,
  outcome: TurnOutcome,
  retry: RetryRecord | undefined,
): Promise<RunStop> {
  if (outcome.kind === 'aborted') {
    state.abandoned = true;
    return guard.stop ?? { kind: 'aborted', reason: outcome.reason };
  }
  const denials = installed.denials();
  if (denials.length > 0) return { kind: 'denied', denials };
  const withRetry = retry === undefined ? {} : { retry };
  if (outcome.kind === 'completed') {
    const items = entriesToTranscript(
      await readConversationEntries(lane.conversation, state.context),
    );
    return {
      kind: 'completed',
      summary: assistantSummary(items),
      ...withRetry,
    };
  }
  return { kind: 'failed', outcome, ...withRetry };
}
