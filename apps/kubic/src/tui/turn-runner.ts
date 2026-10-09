// The prompt turn driver: one accepted prompt driven to settlement on the
// durable lane (the submit + wait), with the conversation's committed events
// folded into the views as they arrive. `cancel` aborts the conversation
// through the loop's durable abort — the same path the quit drain uses — and
// a Ctrl-C that lands while the submit is still in flight is replayed on the
// real turn rather than being lost (or worse, treated as a quit, which would
// kill the process mid-turn).
import { randomUUID } from 'node:crypto';
import type { KubicLaneEvent, LaneEventSink } from '@kubic/agent/lane/events';
import { TURN_BUSY_REASON, type TurnOutcome } from '@kubic/agent/lane/turn';
import type { ModelSelection } from '@kubic/agent/model-select';
import {
  ConversationBusy,
  type ModelThinkingLevel,
  type SubmissionId,
} from '@kubic/agent/pi-boundary';
import type { DebugSink, TurnSpansSink } from '@kubic/host/run';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
import type { TuiApp } from '@kubic/tui/tui-app';
import { TuiTranscriptFeed } from './transcript-feed.js';
import type {
  TuiLaneLoop,
  TuiModelChoice,
  TuiProviderChoice,
  TuiTurnOptions,
  TuiTurnOutcome,
} from './types.js';

// What the busy latch reads for one submitted turn. `pending` is the window
// between `run()` and the harness' admission answer (a Ctrl-C there must
// cancel, never quit); `placed` is work the harness put in the transcript.
// Neither is true for a submission waiting in the inbox — a follow-up
// admitted during a turn, or one a failed run left behind.
interface TuiRunState {
  placed: boolean;
  pending: boolean;
  submissionId?: string;
}

// The key a turn's spans hang on — the placed submission ids
// the harness names on both `run-start` and `run-end`.
function turnKey(inputs: readonly SubmissionId[]): string {
  return inputs.map((input) => String(input)).join(',');
}

export class TuiTurnRunner {
  private readonly app: TuiApp;
  private readonly loop: TuiLaneLoop;
  private model: string;
  // The views the lane events feed.
  private readonly feed: TuiTranscriptFeed;
  // Every turn in flight, from the moment a submit is accepted
  // by the runner, with the placement fact the busy latch reads. A busy
  // Enter adds a QUEUED follow-up's own run here while the running turn is
  // still in it, and the single subscription below serves both: the
  // follow-up's run streams into the same transcript (exactly one lane
  // consumer per conversation).
  private readonly runs = new Map<Promise<TuiTurnOutcome>, TuiRunState>();
  // The first run of the busy period owns the placement latch (Ctrl-C waits
  // for THE running turn to be placed, not for a queued follow-up's
  // admission, which is immediate and needs no placement).
  private placementOwned = false;
  // The one lane-event subscription of the current busy period.
  private attached = false;
  private attaching: Promise<void> | undefined;
  private detach: (() => Promise<void>) | undefined;
  private aborted = false;
  // The durable run has started (the `run-start` lane event): the placement
  // signal a pre-submit Ctrl-C waits for, so its abort cannot slip between
  // the submit and the moment the run owns the conversation. Kept from the
  // FIRST run of the busy period: a queued follow-up is admitted at once,
  // so the turn the operator asked to cancel is the one that was running.
  private placed: Promise<void> = Promise.resolve();
  private markPlaced: () => void = () => {};
  // Set once a quit starts draining: from then on the operation's kills stay
  // registered for the session close's backstop even if the turn settles.
  private quitting = false;
  // Every lane event, before the views fold it in (the root
  // requests a journal read on tool-end and owns the queue map).
  private readonly onLaneEvent: ((event: KubicLaneEvent) => void) | undefined;
  // Per-turn spans (absent means the turn records none).
  private readonly spans: TurnSpansSink | undefined;
  // The live thinking level (the `pi.agent` document). Read once
  // from the lane, then kept by every switch — the status bar and the
  // `/thinking` report read the same value.
  private thinking: ModelThinkingLevel | undefined;

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    // Called after a mid-turn transcript apply lands (the root repaints).
    onUpdate?: () => void,
    onLaneEvent?: (event: KubicLaneEvent) => void,
    // The session's committed spend, so the first live usage
    // event APPENDS to it instead of replacing the bar with the new row
    // alone (a resumed session's earlier turns are not re-emitted).
    usageRows: ReadonlyArray<StatusUsageRow> = [],
    // Per-turn spans; absent means the turn records none.
    spans?: TurnSpansSink,
    // The debug sink; absent drops the lines (the fault
    // notice still renders — it does not need the sink).
    debug?: DebugSink,
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onLaneEvent = onLaneEvent;
    this.spans = spans;
    this.feed = new TuiTranscriptFeed(app, usageRows, onUpdate, debug);
  }

  setQueuedText(text: ReadonlyMap<string, string>): void {
    this.feed.setQueuedText(text);
  }

  refreshPresentation(): void {
    this.feed.refreshPresentation();
  }

  async refreshTranscript(): Promise<void> {
    await this.feed.refresh(() => this.loop.entries(this.loop.context));
  }

  // The live model label (updated by a `/model` switch), so the
  // `/model` report and the headers never read a stale boot snapshot.
  get modelRef(): string {
    return this.model;
  }

  get thinkingRef(): ModelThinkingLevel | undefined {
    return this.thinking;
  }

  // `/model provider/id`. The loop owns the lane-side switch
  // (catalog resolution, conversation.configure, read-back); this runner
  // keeps the model the app's status bar and every later header names.
  // The reason rides to the loop for the escalation event —
  // `/model` passes none, `/escalate` the operator's words.
  async switchModel(
    selection: ModelSelection,
    reason?: string,
  ): Promise<string> {
    const switchModel = this.loop.switchModel;
    if (switchModel === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    const label = await switchModel(
      { provider: selection.provider, modelId: selection.id },
      this.loop.context,
      reason,
    );
    this.model = label;
    // The switch re-clamped the level in the lane, so the
    // cache is dropped and re-read — the status bar and `/thinking` report
    // the effective level, not the one the previous model carried.
    this.thinking = undefined;
    const thinking = await this.liveThinking().catch(() => undefined);
    this.app.setModel(label, thinking);
    // The gauge follows the model. A loop without the lookup
    // (injected viewer shells) leaves the seeded limits alone.
    const limits = this.loop.contextLimits?.(selection.provider, selection.id);
    if (limits !== undefined) this.app.setContextLimits(limits);
    return label;
  }

  /** The live level, read from the lane on first use. */
  async liveThinking(): Promise<ModelThinkingLevel> {
    if (this.thinking !== undefined) return this.thinking;
    const read = this.loop.thinking;
    if (read === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    this.thinking = await read(this.loop.context);
    return this.thinking;
  }

  // `/thinking <level>` and the cycle key. The lane clamps to
  // what the live model supports and returns the EFFECTIVE level; the app's
  // status bar moves to it (the header keeps the model).
  async switchThinking(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
    const switchThinking = this.loop.switchThinking;
    if (switchThinking === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    const effective = await switchThinking(level, this.loop.context);
    this.thinking = effective;
    this.app.setModel(this.model, effective);
    return effective;
  }

  /** The levels the live model supports, in ladder order. */
  async supportedThinking(): Promise<readonly ModelThinkingLevel[]> {
    const supported = this.loop.supportedThinking;
    if (supported === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    return supported(this.loop.context);
  }

  /** The catalog rows the picker offers, the live model marked. */
  async listModels(): Promise<readonly TuiModelChoice[]> {
    const list = this.loop.listModels;
    if (list === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    return list(this.loop.context);
  }

  /** Every provider, keyless ones included (none: an empty list). */
  async listProviders(): Promise<readonly TuiProviderChoice[]> {
    return (await this.loop.listProviders?.(this.loop.context)) ?? [];
  }

  // Busy from the moment a submit is accepted by the loop — not from the moment
  // the durable turn lands — so the Ctrl-C that follows Enter by a keystroke
  // still cancels instead of quitting. Busy means PLACED work: a follow-up
  // waiting in the inbox — admitted while a turn ran, or left behind by a
  // failed run — is not a run, so the spinner stops and the queued row is the
  // state the operator sees.
  isRunning(): boolean {
    for (const state of this.runs.values()) {
      if (state.pending || state.placed) return true;
    }
    return false;
  }

  // The single lane-event consumer for this conversation (exactly one).
  private readonly sink: LaneEventSink = (event: KubicLaneEvent): void => {
    // The loop's own bookkeeping runs FIRST: it owns the queue map the state
    // resolves `lane.queued` from (a `run-start` drops the id the harness just
    // placed), so folding before it would hand the app a row the placement
    // already consumed — and then no further event would clear it.
    this.onLaneEvent?.(event);
    this.feed.apply(event);
    if (event.type === 'run-start') {
      // The run is placed: a latched Ctrl-C may now abort it for real, and a
      // submission the harness queued earlier (a follow-up waiting behind a
      // failed run) counts as work in flight from this moment.
      this.markPlaced();
      this.markPlacedInputs(event.inputs);
      // The turn's run span opens on placement.
      this.spans?.turns.startRun(turnKey(event.inputs));
    }
    if (event.type === 'tool-start') {
      // The turn's tool span opens with the call.
      this.spans?.turns.startTool(event.toolCallId, event.toolName);
    }
    if (event.type === 'tool-end') {
      // Entry or not, the call settled — a faulted or orphaned
      // call has no entry but its span still closes.
      this.spans?.turns.endTool(event.toolCallId, event.isError);
    }
    if (event.type === 'run-end') this.flushSpans(event.inputs);
  };

  // The turn settled — flush its artifact (run span plus
  // its tool spans). Telemetry never fails a turn.
  private flushSpans(inputs: readonly SubmissionId[]): void {
    const spans = this.spans;
    if (spans === undefined) return;
    const artifact = spans.turns.endRun(turnKey(inputs));
    if (artifact === undefined) return;
    try {
      spans.write(artifact);
    } catch {
      // A failed artifact write is not a turn failure.
    }
  }

  // The in-flight runs: a quit waits on them, bounded. The
  // runner is BUSY while a submit is still being admitted or a run is placed
  // — a queued item waiting in the inbox is not work in flight.
  run(prompt: string, options: TuiTurnOptions = {}): Promise<TuiTurnOutcome> {
    const state: TuiRunState = { placed: false, pending: true };
    const running = this.runTurn(
      prompt,
      {
        ...options,
        onSubmitted: (submissionId, admitted) => {
          state.pending = false;
          state.submissionId = submissionId;
          // A submission admitted into the inbox (a busy follow-up, or one
          // queued behind a failed run's leftovers) is not placed work: it
          // becomes busy only if the harness places it later, which the
          // `run-start` event reports.
          state.placed = admitted === 'placed';
          options.onSubmitted?.(submissionId, admitted);
        },
      },
      state,
    );
    this.runs.set(running, state);
    const finished = (): void => {
      this.runs.delete(running);
      // The busy period ends with its LAST turn: only then is the lane-event
      // subscription released (a queued follow-up still streaming must keep
      // its consumer).
      if (this.runs.size === 0) void this.releaseSubscription();
    };
    void running.then(finished, finished);
    return running;
  }

  // The harness placed a submission (`run-start`): the run that
  // was waiting for it is working now, so the busy latch must follow.
  private markPlacedInputs(inputs: readonly SubmissionId[]): void {
    for (const state of this.runs.values()) {
      if (state.submissionId === undefined) continue;
      if (inputs.some((input) => String(input) === state.submissionId)) {
        state.placed = true;
      }
    }
  }

  // The busy period's ONE subscription. It is taken by the first
  // turn and dropped when the last settles, so a queued follow-up's run —
  // placed by the harness after the first turn answers — keeps feeding the
  // same app feed. The attach snapshot is snapshot-safe: REPLACE
  // semantics mean re-taking it loses nothing.
  private async ensureSubscription(): Promise<void> {
    if (this.attached) return;
    const attaching =
      this.attaching ??
      (async () => {
        this.detach = await this.loop.subscribe(this.sink, this.loop.context);
        this.attached = true;
      })();
    this.attaching = attaching;
    try {
      await attaching;
    } finally {
      if (this.attaching === attaching) this.attaching = undefined;
    }
  }

  private async releaseSubscription(): Promise<void> {
    // A turn may have subscribed and settled inside the same tick: wait for
    // that attempt before reading what it installed.
    if (this.attaching !== undefined) {
      await this.attaching.catch(() => undefined);
    }
    // A turn may have arrived while this release waited for the attach:
    // never drop the consumer of a live run.
    if (this.runs.size > 0 || !this.attached) return;
    const detach = this.detach;
    this.detach = undefined;
    this.attached = false;
    try {
      await detach?.();
    } catch {
      // A torn-down watch is not a turn failure.
    }
  }

  // Quitting mid-turn aborts and drains the
  // conversation — the durable abort, then every registered kill — and waits
  // for the run to settle, at most until `bound` resolves. A quit that lands
  // before the submit waits for the placement and aborts then (see below).
  // When the bound wins, the registered kills still run: the registry drain
  // is the backstop and must not queue behind an abort that may never answer
  // (`abortLane` drains them again — a no-op).
  async drainForQuit(bound: Promise<void>): Promise<void> {
    if (!this.isRunning()) return;
    this.aborted = true;
    this.quitting = true;
    // The run may not be placed yet: aborting now would hit an idle
    // conversation and the turn would outlive the quit. Wait for the
    // placement (or the turn's end) first, bounded by the same quit bound so
    // a submit that never lands cannot hang the quit either.
    await Promise.race([this.placed, bound]);
    await Promise.race([
      this.loop.abort(this.loop.context).catch(() => undefined),
      bound,
    ]);
    for (const kill of this.loop.kills.drain(this.loop.killsKey)) {
      try {
        kill();
      } catch {
        // Already exited — the registry drains every entry regardless.
      }
    }
    // Every turn of the busy period settles before the quit resolves: the
    // follow-ups the abort withdrew settle as aborted on the same path.
    const settled = Promise.all(
      [...this.runs.keys()].map((running) =>
        running.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([settled, bound]);
  }

  // One turn: settle it on the durable lane, then hand the turn's own record
  // to the run's trajectory — the recording never changes
  // the turn's outcome. The record is per-turn: two runs can overlap
  // while a follow-up waits in the inbox.
  private async runTurn(
    prompt: string,
    options: TuiTurnOptions,
    state: TuiRunState,
  ): Promise<TuiTurnOutcome> {
    const startedAt = Date.now();
    const record: { turn?: TurnOutcome } = {};
    const outcome = await this.drive(prompt, options, record, state);
    try {
      await this.loop.recordTurn?.({
        prompt,
        startedAt,
        outcome,
        ...(record.turn === undefined ? {} : { turn: record.turn }),
      });
    } catch {
      // The trajectory observes the turn; it never changes its outcome.
    }
    // The turn's trajectory warnings, as transcript notices (the
    // screen is up, so stderr would paint over it).
    for (const line of this.loop.drainNotices?.() ?? []) {
      this.app.appendNotice([line]);
    }
    // Report recorded climbs — explicit or
    // automatic — as transcript rows, each exactly once. The drain is
    // idempotent, so a turn settling right after a switch reports the
    // row even when the switch already drained it (then: nothing new).
    for (const row of this.loop.drainEscalationRows?.() ?? []) {
      this.app.appendNotice([row]);
    }
    return outcome;
  }

  private async drive(
    prompt: string,
    options: TuiTurnOptions,
    record: { turn?: TurnOutcome },
    state: TuiRunState,
  ): Promise<TuiTurnOutcome> {
    this.aborted = false;
    // The first run of the busy period owns the placement latch: Ctrl-C
    // waits for THE running turn to be placed, not for a queued follow-up's
    // admission (which is immediate and needs no placement).
    const first = !this.placementOwned;
    this.placementOwned = true;
    let markPlaced: () => void = () => {};
    const placed = new Promise<void>((resolve) => {
      markPlaced = resolve;
    });
    if (first) {
      this.placed = placed;
      this.markPlaced = markPlaced;
    }
    try {
      const turn = await this.submit(prompt, options);
      record.turn = turn;
      // A SETTLED turn's kills are forgotten, not run: a kept background job
      // outlives Kubic, and a recycled pid must not receive a stale group
      // SIGTERM. A failed outcome is not settled — the busy refusal never
      // owned a turn and a failed wait may still have a live durable run —
      // so its kills stay registered for the abort/quit drain. A quit keeps
      // them for the session close's backstop either way.
      if (
        !this.quitting &&
        (turn.kind === 'completed' || turn.kind === 'aborted')
      ) {
        this.loop.forgetKills();
      }
      // One settling read completes the feed (the user entry the submit
      // committed is not carried by any mapped event): events drive the live
      // transcript, this single read is the turn's full one.
      // A turn that ends without a committed assistant entry
      // (an abort mid-stream) leaves no draft behind.
      this.feed.clearStream();
      await this.refreshTranscript();
      return settledOutcome(turn);
    } catch (error) {
      // Defensive: lane/turn.ts maps a rejected submit to a busy failure, so a
      // ConversationBusy escaping here is a wiring bug — report it as the
      // refusal it is instead of crashing the loop.
      if (error instanceof ConversationBusy) {
        return {
          status: 'failed',
          detail: `lane refused the prompt: ${error.message}`,
        };
      }
      throw error;
    } finally {
      // A run that never started (a refused submit, a failure) must not
      // leave a latched Ctrl-C waiting for a placement that cannot come, nor
      // hold the busy latch as a pending submit forever.
      state.pending = false;
      if (first) this.placementOwned = false;
      markPlaced();
    }
  }

  // The durable submit and wait. The subscription is snapshot-safe: the
  // attach snapshot replaces the feed, so nothing committed between the boot
  // read and this turn can be lost, and no event can arrive before the sink
  // is listening. ONE subscription serves the whole busy period.
  private async submit(
    prompt: string,
    options: TuiTurnOptions,
  ): Promise<TurnOutcome> {
    await this.ensureSubscription();
    return this.loop.runTurn(prompt, {
      // The prompt is this invocation's own intent: a fresh id per submit
      // so pi-durable's requestId dedupe never collapses two prompts the
      // operator really sent.
      requestId: randomUUID(),
      context: this.loop.context,
      ...(options.images === undefined || options.images.length === 0
        ? {}
        : { images: options.images }),
      // A queued follow-up / steer is the caller's explicit
      // mode; anything else keeps `reject` — a submit that races a
      // settling turn fails loudly instead of sitting in the inbox.
      whenBusy: options.whenBusy ?? 'reject',
      ...(options.onSubmitted === undefined
        ? {}
        : { onSubmitted: options.onSubmitted }),
    });
  }

  // Ctrl-C: the lane can always be cancelled. Part of TuiTurnDriver.
  canCancel(): boolean {
    return true;
  }

  // True between a cancel request and the turn settling: the loop uses it to
  // distinguish the *first* Ctrl-C (cancel the operation) from a second one
  // (quit), which is the shipped contract in docs/cli/commands.md.
  isCancelling(): boolean {
    return this.aborted && this.isRunning();
  }

  // Cancels the in-flight turn. Returns false when nothing is running, so
  // the caller can fall through to quit. Before the submit lands the request
  // is latched and replayed by `drive`, so the key is never lost. It THROWS
  // when the abort refused (abortLane aggregates the failure); the key
  // handler catches it and reports it, so a refusal is never a silent no-op
  // and never an unhandled rejection.
  async cancel(): Promise<boolean> {
    if (!this.isRunning()) return false;
    this.aborted = true;
    // A Ctrl-C can beat the durable submit: aborting an idle conversation is
    // a no-op, so the abort waits for the run's own `run-start` placement (or
    // for the turn to end) instead of slipping between the two.
    await this.placed;
    if (this.quitting) return true;
    // The durable abort path: conversation.abort + the conversation's
    // kill drain. It THROWS when the abort or a kill fails, so the cancel
    // path reports a refusal instead of a silent no-op.
    await this.loop.abort(this.loop.context);
    return true;
  }
}

// The lane's own terminal record is authoritative: an abort that raced
// a completing turn must not be relabelled as cancelled (the work
// really did land), and a turn the abort did stop settles 'aborted'.
function settledOutcome(turn: TurnOutcome): TuiTurnOutcome {
  if (turn.kind === 'completed') return { status: 'completed' };
  if (turn.kind === 'aborted') return { status: 'cancelled' };
  // `FailureCode` is the closed vocabulary; the busy refusal is Kubic's
  // own reason and may or may not be part of it depending on the
  // turn module's typing, so the comparison is on the plain string.
  const reason: string = turn.reason;
  if (reason === TURN_BUSY_REASON) {
    // The busy refusal keeps the shape the operator saw when the lane
    // refused an admission: the prompt never reaches the model.
    return {
      status: 'failed',
      detail: `lane refused the prompt: ${turn.error ?? 'the conversation is busy'}`,
    };
  }
  return {
    status: 'failed',
    detail: turn.error ?? `lane ${turn.reason}`,
  };
}
