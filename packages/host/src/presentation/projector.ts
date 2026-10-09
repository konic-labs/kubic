// The host-side projector: folds the replicated event stream
// into a `KubicPresentationState`, so the presentation renders state instead
// of folding raw events ("The presentation does not fold raw events").
//
// Pure: no I/O, no authority, no harness access. The lane source is the
// `subscribeLaneEvents` stream (itself pi-durable's `watchEvents`);
// approvals are narrow typed events the host feeds in (`applyApproval`).
//
// One session, one lane: the TUI renders exactly one lane, the session's own.

import type { KubicLaneEvent } from '@kubic/agent/lane/events';
import type {
  KubicPresentationState,
  LaneSnapshot,
  LaneToolSnapshot,
  UsageTotals,
} from '@kubic/core/presentation';
import { PRESENTATION_STATE_FIELDS } from '@kubic/core/presentation';

export interface PresentationSeed {
  readonly sessionId: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly approvalsSkipped: boolean;
  /** The session's workspace (the repo root). */
  readonly workspace?: string;
}

// One approval fact. `ask` adds the pending request, `settled` removes it.
export interface ApprovalProjectionEvent {
  readonly type: 'ask' | 'settled';
  readonly requestId: string;
  readonly toolName?: string;
  readonly capability?: string;
  readonly detail?: string;
}

function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    requests: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export class PresentationProjector {
  private readonly now: () => number;
  // Tool-call start times, so the state carries the duration the tree shows.
  private readonly toolStartedAt = new Map<string, number>();
  private current: KubicPresentationState;
  // The inbox carries submission ids, not content; the loop owns the
  // prompt text of the submissions it queued, so it hands the map in and the
  // projector resolves the rows.
  private queuedText: ReadonlyMap<string, string> = new Map();
  // The inbox's ids as of the last `inbox` event; the text comes from
  // `queuedText` when the state is handed out.
  private queuedItems: ReadonlyArray<{ readonly id: string | number }> = [];
  // The projector's monotonic fold counter: a consumer can tell
  // a fresh state from the one it last rendered without diffing. Deliberately
  // NOT a presentation state field — the contract's keys stay exact.
  private fold = 0;

  constructor(seed: PresentationSeed, now: () => number = Date.now) {
    this.now = now;
    this.current = {
      session: {
        sessionId: seed.sessionId,
        approvalsSkipped: seed.approvalsSkipped,
        ...(seed.model === undefined ? {} : { model: seed.model }),
        ...(seed.thinking === undefined ? {} : { thinking: seed.thinking }),
        ...(seed.workspace === undefined ? {} : { workspace: seed.workspace }),
      },
      lane: {
        status: 'idle',
        tools: [],
        queued: [],
        compacting: false,
      },
      approvals: [],
      usage: emptyUsage(),
      connection: { status: 'connected' },
    };
  }

  /** The fold counter: 0 at the seed, +1 per applied fact. */
  revision(): number {
    return this.fold;
  }

  state(): KubicPresentationState {
    // 's closed-world check at runtime, not just in types: the projector
    // can never hand the presentation a state missing one of the replicated
    // fields (and this value use is what makes the contract reachable from
    // the binary, the acceptance).
    for (const field of Object.keys(PRESENTATION_STATE_FIELDS)) {
      if (!(field in this.current)) {
        throw new Error(`presentation state lost '${field}'`);
      }
    }
    this.syncQueued();
    return this.current;
  }

  // Resolve the inbox ids to prompt text against the loop's live map. The state
  // is the ONE writer of the queued rows, so this runs on every hand-out
  // instead of only on an `inbox` event.
  private syncQueued(): void {
    const lane = this.current.lane;
    const queued = this.queuedItems
      .map((item) => this.queuedText.get(String(item.id)))
      .filter((text): text is string => text !== undefined);
    if (
      queued.length === lane.queued.length &&
      queued.every((text, index) => text === lane.queued[index])
    ) {
      return;
    }
    this.current = { ...this.current, lane: { ...lane, queued } };
  }

  apply(event: KubicLaneEvent): void {
    switch (event.type) {
      case 'snapshot': {
        // REPLACE semantics: the snapshot is the lane's whole state.
        this.patchLane({
          tools: event.tools.map((tool) => ({
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            status: tool.status === 'done' ? 'done' : 'running',
            isError: tool.isError,
            ...(tool.entry === undefined ? {} : { entry: tool.entry }),
          })),
          status:
            event.run === undefined
              ? this.current.lane.status === 'running'
                ? 'done'
                : this.current.lane.status
              : 'running',
          compacting: event.compactions.length > 0,
          ...(event.retry === undefined
            ? {}
            : {
                retrying: {
                  attempt: event.retry.attempt,
                  error: event.retry.error,
                },
              }),
        });
        // The snapshot's `usage` is the session's cumulative `pi.usage`
        // ledger (the same value seeds the bar from) and every other
        // field of this branch is REPLACE — adding it would double the
        // totals on the watch's overflow rebase.
        this.current = {
          ...this.current,
          usage: usageTotalsOf(event.usage),
        };
        this.fold += 1;
        return;
      }
      case 'run-start': {
        // The turn boundary is the projector's: the
        // lane's `tools` list is a running list across turns, and only a
        // snapshot replaces it, so without this the previous turn's calls
        // render as live rows again and the tree's rollup counts them twice.
        this.patchLane({ status: 'running', tools: [] });
        return;
      }
      case 'run-end': {
        this.patchLane({ status: 'done', retrying: undefined });
        return;
      }
      case 'tool-start': {
        this.toolStartedAt.set(event.toolCallId, this.now());
        this.upsertTool({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'running',
          isError: false,
          args: event.args,
        });
        return;
      }
      case 'tool-end': {
        const previous = this.current.lane.tools.find(
          (tool) => tool.toolCallId === event.toolCallId,
        );
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        this.toolStartedAt.delete(event.toolCallId);
        this.upsertTool({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'done',
          isError: event.isError,
          ...(previous?.args === undefined ? {} : { args: previous.args }),
          ...(event.entry === undefined ? {} : { entry: event.entry }),
          ...(startedAt === undefined
            ? {}
            : { durationMs: Math.max(0, this.now() - startedAt) }),
        });
        return;
      }
      case 'usage': {
        this.patchUsage({
          inputTokens: event.row.usage.input,
          outputTokens: event.row.usage.output,
          costUsd: event.row.usage.cost.total,
          cacheReadTokens: event.row.usage.cacheRead,
          cacheWriteTokens: event.row.usage.cacheWrite,
        });
        return;
      }
      case 'inbox': {
        // The inbox is a snapshot per commit: admission, placement and
        // withdrawal all emit it. Only the IDS are remembered here — the
        // prompt text is resolved in `state()`, because the loop's in-place
        // map drops an id the moment the harness PLACES it (a `run-start`),
        // and the app writes `lane.queued` on every presentation apply.
        this.queuedItems = event.items;
        this.fold += 1;
        return;
      }
      case 'fault': {
        this.patchLane({ fault: `${event.code}: ${event.message}` });
        return;
      }
      case 'retry': {
        this.patchLane(
          event.phase === 'start'
            ? {
                retrying: {
                  attempt: event.attempt ?? 1,
                  ...(event.error === undefined ? {} : { error: event.error }),
                },
              }
            : { retrying: undefined },
        );
        return;
      }
      case 'compaction': {
        this.patchLane({ compacting: event.phase === 'start' });
        return;
      }
      default: {
        // `message-delta` streams into the transcript draft and `entry`
        // carries a committed non-assistant entry to the transcript's cells:
        // neither changes the LANE's state (the lane's own facts are the
        // status/tools/queue fields folded above).
        return;
      }
    }
  }

  applyApproval(event: ApprovalProjectionEvent): void {
    const approvals = this.current.approvals.filter(
      (request) => request.requestId !== event.requestId,
    );
    if (event.type === 'ask') {
      approvals.push({
        requestId: event.requestId,
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        ...(event.capability === undefined
          ? {}
          : { capability: event.capability }),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
    }
    this.current = { ...this.current, approvals };
    this.fold += 1;
  }

  /** Queues: the prompt text of the submissions the loop queued. */
  setQueuedText(text: ReadonlyMap<string, string>): void {
    this.queuedText = text;
  }

  private patchLane(patch: Partial<LaneSnapshot>): void {
    this.current = {
      ...this.current,
      lane: { ...this.current.lane, ...patch },
    };
    this.fold += 1;
  }

  private upsertTool(tool: LaneToolSnapshot): void {
    const lane = this.current.lane;
    const tools = lane.tools.filter(
      (candidate) => candidate.toolCallId !== tool.toolCallId,
    );
    tools.push(tool);
    this.patchLane({ tools });
  }

  private patchUsage(delta: Partial<UsageTotals>): void {
    const usage = this.current.usage;
    this.current = {
      ...this.current,
      usage: {
        inputTokens: usage.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (delta.outputTokens ?? 0),
        costUsd: usage.costUsd + (delta.costUsd ?? 0),
        requests: (usage.requests ?? 0) + (delta.requests ?? 1),
        cacheReadTokens:
          (usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
        cacheWriteTokens:
          (usage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
      },
    };
    this.fold += 1;
  }
}

// The snapshot's `pi.usage` ledger (per model and per tool), summed.
function usageTotalsOf(usage: {
  models: Record<string, unknown>;
  tools: Record<string, unknown>;
}): UsageTotals {
  const totals = emptyUsage();
  for (const buckets of [usage.models, usage.tools]) {
    for (const bucket of Object.values(buckets)) {
      if (typeof bucket !== 'object' || bucket === null) continue;
      const counters = bucket as {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        cost?: { total?: unknown };
      };
      const num = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;
      totals.inputTokens += num(counters.input);
      totals.outputTokens += num(counters.output);
      totals.cacheReadTokens =
        (totals.cacheReadTokens ?? 0) + num(counters.cacheRead);
      totals.cacheWriteTokens =
        (totals.cacheWriteTokens ?? 0) + num(counters.cacheWrite);
      totals.costUsd += num(counters.cost?.total);
      totals.requests = (totals.requests ?? 0) + 1;
    }
  }
  return totals;
}
