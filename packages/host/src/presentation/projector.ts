// §66's host-side projector (issue #333): folds the replicated event stream
// into a `KubicPresentationState`, so the presentation renders state instead
// of folding raw events (§15.2: "The presentation does not fold raw events").
//
// Pure: no I/O, no authority, no harness access. The lane source is the
// `subscribeLaneEvents` stream (#398, itself pi-durable's `watchEvents`); the
// worker and approval sources are narrow typed events the host feeds in
// (`applyWorker` / `applyApproval`), because those lifecycles own their own
// vocabularies and the projector must not depend on them.
//
// The root lane's id IS the session id: the solo TUI has exactly one lane
// (D2), and a worker lane appears in `workers`, not as a second lane.

import type {
  AgentSummary,
  ApprovalRequest,
  BudgetSummary,
  KubicPresentationState,
  LaneSnapshot,
  LaneToolSnapshot,
  RunPhase,
  RunPhaseState,
  UsageTotals,
  WorkerDiffStat,
  WorkerSummary,
  WorkerToolActivity,
} from '../../../core/src/presentation.js';
import {
  PRESENTATION_STATE_FIELDS,
  RUN_PHASES,
} from '../../../core/src/presentation.js';
import type { KubicLaneEvent } from '../../../worker/src/lane/events.js';

export interface PresentationSeed {
  readonly sessionId: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly mode: 'solo' | 'orchestrator';
  readonly approvalsSkipped: boolean;
  /** The agent's workspace (the repo root for a solo lane). */
  readonly workspace?: string;
}

// One worker lifecycle fact (issue #333). Structural: the lifecycle layer's
// own event types feed this without the projector importing them.
export interface WorkerProjectionEvent {
  readonly type: 'worker-start' | 'worker-update' | 'worker-end';
  readonly workerId: string;
  readonly role?: string;
  readonly status?: string;
  readonly workspace?: string;
  readonly budget?: BudgetSummary;
  readonly generation?: number;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  // Issue #464: the worker's task, the tool facts its process reported since
  // the last event (one batch, oldest first — folded into its activity, count
  // and recent ring), its change summary, and the approval it waits on
  // (`null` clears it).
  readonly task?: string;
  readonly facts?: readonly WorkerToolActivity[];
  readonly diffStat?: WorkerDiffStat;
  readonly awaiting?: {
    readonly approvalKey: string;
    readonly summary: string;
  } | null;
}

// Issue #464: an orchestrator run phase changed.
export interface RunPhaseProjectionEvent {
  readonly type: 'run-phase';
  readonly phase: RunPhase;
  readonly state: RunPhaseState['state'];
  readonly at: number;
}

// Issue #464: what an orchestrator run reports to the view — worker facts
// and its phase transitions.
export type OrchestratorProjectionEvent =
  | WorkerProjectionEvent
  | RunPhaseProjectionEvent;

/** The recent tool calls a worker keeps, and the diff text each may hold. */
export const WORKER_RECENT_TOOLS = 8;
export const WORKER_DIFF_MAX_CHARS = 20 * 1024;

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

function laneOf(
  state: KubicPresentationState,
  laneId: string,
): LaneSnapshot | undefined {
  return state.lanes.get(laneId);
}

export class PresentationProjector {
  // Issue #464: the tool calls each worker has reported (its count).
  private readonly seenTools = new Map<string, Set<string>>();
  private readonly rootLaneId: string;
  private readonly now: () => number;
  // Tool-call start times, so the state carries the duration the tree shows.
  private readonly toolStartedAt = new Map<string, number>();
  private current: KubicPresentationState;
  // The inbox carries submission ids, not content (#334); the loop owns the
  // prompt text of the submissions it queued, so it hands the map in and the
  // projector resolves the rows.
  private queuedText: ReadonlyMap<string, string> = new Map();
  // The inbox's ids as of the last `inbox` event (#334); the text comes from
  // `queuedText` when the state is handed out.
  private queuedItems: ReadonlyArray<{ readonly id: string | number }> = [];
  // The projector's monotonic fold counter (issue #333): a consumer can tell
  // a fresh state from the one it last rendered without diffing. Deliberately
  // NOT a §66 state field — the contract's seven keys stay exact.
  private fold = 0;

  constructor(seed: PresentationSeed, now: () => number = Date.now) {
    this.rootLaneId = seed.sessionId;
    this.now = now;
    this.current = {
      session: {
        sessionId: seed.sessionId,
        mode: seed.mode,
        approvalsSkipped: seed.approvalsSkipped,
        ...(seed.model === undefined ? {} : { model: seed.model }),
        ...(seed.thinking === undefined ? {} : { thinking: seed.thinking }),
      },
      agents: new Map([
        [
          'root',
          {
            agentId: 'root',
            role: 'root',
            status: 'idle',
            ...(seed.workspace === undefined
              ? {}
              : { workspace: seed.workspace }),
          },
        ],
      ]),
      lanes: new Map([
        [
          this.rootLaneId,
          {
            laneId: this.rootLaneId,
            agentId: 'root',
            status: 'idle',
            tools: [],
            queued: [],
            compacting: false,
          },
        ],
      ]),
      workers: new Map(),
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
    // §66's closed-world check at runtime, not just in types: the projector
    // can never hand the presentation a state missing one of the replicated
    // fields (and this value use is what makes the contract reachable from
    // the binary, issue #333's acceptance).
    for (const field of Object.keys(PRESENTATION_STATE_FIELDS)) {
      if (!(field in this.current)) {
        throw new Error(`presentation state lost '${field}'`);
      }
    }
    this.syncQueued();
    return this.current;
  }

  // Resolve the inbox ids to prompt text against the loop's live map (issue
  // #333 review). The state is the ONE writer of the queued rows, so this
  // runs on every hand-out instead of only on an `inbox` event.
  private syncQueued(): void {
    const lane = this.rootLane();
    const queued = this.queuedItems
      .map((item) => this.queuedText.get(String(item.id)))
      .filter((text): text is string => text !== undefined);
    if (
      queued.length === lane.queued.length &&
      queued.every((text, index) => text === lane.queued[index])
    ) {
      return;
    }
    const lanes = new Map(this.current.lanes);
    lanes.set(this.rootLaneId, { ...lane, queued });
    this.current = { ...this.current, lanes };
  }

  /** The lane the TUI renders (the solo lane's id is the session id). */
  get laneId(): string {
    return this.rootLaneId;
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
              ? this.rootLane().status === 'running'
                ? 'done'
                : this.rootLane().status
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
        // ledger (the same value #346 seeds the bar from) and every other
        // field of this branch is REPLACE — adding it would double the
        // totals on the watch's overflow rebase (issue #333 review).
        this.current = {
          ...this.current,
          usage: usageTotalsOf(event.usage),
        };
        this.fold += 1;
        return;
      }
      case 'run-start': {
        // The turn boundary is the projector's (issue #333 review): the
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
        const previous = this.rootLane().tools.find(
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
        // The inbox is a snapshot per commit (#334): admission, placement and
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

  applyWorker(event: WorkerProjectionEvent): void {
    const workers = new Map(this.current.workers);
    if (event.type === 'worker-end') {
      workers.delete(event.workerId);
      this.seenTools.delete(event.workerId);
    } else {
      const previous = workers.get(event.workerId);
      const next: WorkerSummary = {
        workerId: event.workerId,
        role: event.role ?? previous?.role,
        status: event.status ?? previous?.status ?? 'running',
        workspace: event.workspace ?? previous?.workspace,
        budget: event.budget ?? previous?.budget,
        generation: event.generation ?? previous?.generation,
        model: event.model ?? previous?.model,
        inputTokens: event.inputTokens ?? previous?.inputTokens,
        outputTokens: event.outputTokens ?? previous?.outputTokens,
        costUsd: event.costUsd ?? previous?.costUsd,
        task: event.task ?? previous?.task,
        activity: previous?.activity,
        toolCount: previous?.toolCount,
        recentTools: previous?.recentTools,
        diffStat: event.diffStat ?? previous?.diffStat,
        awaiting:
          event.awaiting === null
            ? undefined
            : (event.awaiting ?? previous?.awaiting),
      };
      for (const fact of event.facts ?? []) this.foldTool(next, fact);
      workers.set(event.workerId, next);
    }
    this.current = { ...this.current, workers };
    this.fold += 1;
  }

  // Issue #464: one tool fact — the latest activity, the distinct-call
  // count, and the ring of the last WORKER_RECENT_TOOLS calls (a call's
  // later state replaces its earlier one in place).
  private foldTool(worker: WorkerSummary, fact: WorkerToolActivity): void {
    const bounded: WorkerToolActivity =
      fact.diff !== undefined && fact.diff.text.length > WORKER_DIFF_MAX_CHARS
        ? {
            ...fact,
            diff: {
              ...fact.diff,
              text: fact.diff.text.slice(0, WORKER_DIFF_MAX_CHARS),
            },
          }
        : fact;
    const seen = this.seenTools.get(worker.workerId) ?? new Set<string>();
    if (!seen.has(fact.id)) {
      seen.add(fact.id);
      this.seenTools.set(worker.workerId, seen);
    }
    const ring = [...(worker.recentTools ?? [])];
    const at = ring.findIndex((tool) => tool.id === fact.id);
    if (at === -1) ring.push(bounded);
    else ring[at] = bounded;
    worker.activity = bounded;
    worker.toolCount = seen.size;
    worker.recentTools = ring.slice(-WORKER_RECENT_TOOLS);
  }

  /** Issue #464: one orchestrator fact, whichever kind it is. */
  applyOrchestrator(event: OrchestratorProjectionEvent): void {
    if (event.type === 'run-phase') this.applyRunPhase(event);
    else this.applyWorker(event);
  }

  /**
   * Issue #464: a run phase changed. The phases stay in run order whatever
   * order they were reported in, and a plan starting again is a new run.
   */
  applyRunPhase(event: RunPhaseProjectionEvent): void {
    const previous = this.current.session.runPhases ?? [];
    const fresh =
      event.phase === 'plan' &&
      event.state === 'running' &&
      previous.some(
        (phase) => phase.phase !== 'plan' || phase.state !== 'running',
      );
    const phases = (fresh ? [] : previous).filter(
      (phase) => phase.phase !== event.phase,
    );
    phases.push({ phase: event.phase, state: event.state, at: event.at });
    phases.sort(
      (a, b) => RUN_PHASES.indexOf(a.phase) - RUN_PHASES.indexOf(b.phase),
    );
    this.current = {
      ...this.current,
      session: { ...this.current.session, runPhases: phases },
    };
    this.fold += 1;
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

  /** §66 queues: the prompt text of the submissions the loop queued. */
  setQueuedText(text: ReadonlyMap<string, string>): void {
    this.queuedText = text;
  }

  private rootLane(): LaneSnapshot {
    const lane = laneOf(this.current, this.rootLaneId);
    if (lane === undefined) {
      throw new Error(`presentation projector lost lane '${this.rootLaneId}'`);
    }
    return lane;
  }

  private patchLane(patch: Partial<LaneSnapshot>): void {
    const lanes = new Map(this.current.lanes);
    lanes.set(this.rootLaneId, { ...this.rootLane(), ...patch });
    this.current = { ...this.current, lanes };
    this.fold += 1;
  }

  private upsertTool(tool: LaneToolSnapshot): void {
    const lane = this.rootLane();
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

export type { AgentSummary, ApprovalRequest, WorkerSummary };
