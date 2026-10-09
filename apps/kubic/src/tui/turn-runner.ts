// The prompt turn driver: one accepted prompt driven to settlement on the
// durable lane, with the conversation's events folded into the views.
import { randomUUID } from 'node:crypto';
import type { KubicLaneEvent, LaneEventSink } from '@kubic/agent/lane/events';
import type { TurnOutcome } from '@kubic/agent/lane/turn';
import { TURN_BUSY_REASON } from '@kubic/agent/lane/turn';
import type { ModelSelection } from '@kubic/agent/model-select';
import type {
  EntryRecord,
  ModelThinkingLevel,
  SubmissionId,
} from '@kubic/agent/pi-boundary';
import { ConversationBusy } from '@kubic/agent/pi-boundary';
import { PresentationProjector } from '@kubic/host/presentation';
import type { DebugSink, TurnSpansSink } from '@kubic/host/run';
import { hookErrorLine, modelLine } from '@kubic/host/run';
import type { LaneEntryLike } from '@kubic/tui/lane-cells';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
import type { TuiApp } from '@kubic/tui/tui-app';
import { laneEntryFor } from './entries.js';
import type {
  TuiLaneLoop,
  TuiModelChoice,
  TuiProviderChoice,
  TuiTurnOptions,
  TuiTurnOutcome,
} from './types.js';

// Drives one accepted prompt to settlement (the durable submit + wait) and
// folds the conversation's committed lane events into the views as they arrive.
// `cancel` aborts the conversation through the loop's durable abort — the same
// path the quit drain uses — and a Ctrl-C that lands while the submit is still
// in flight is replayed on the real turn rather than being lost (or worse,
// treated as a quit, which would kill the process mid-turn). What the busy
// latch reads for one submitted turn. `pending` is the window between `run()`
// and the harness' admission answer (a Ctrl-C there must cancel, never quit);
// `placed` is work the harness put in the transcript. Neither is true for a
// submission waiting in the inbox — a follow-up admitted during a turn, or one
// a failed run left behind.
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

  // Called after a mid-turn transcript apply lands (the root repaints).
  private readonly onUpdate: (() => void) | undefined;

  // Every lane event, after the app folded it in (the root
  // requests a journal read on tool-end).
  private readonly onLaneEvent: ((event: KubicLaneEvent) => void) | undefined;

  // Per-turn spans (absent means the turn records none).
  private readonly spans: TurnSpansSink | undefined;

  // The debug sink (absent means lines are dropped,
  // except the fault notice which always renders).
  private readonly debug: DebugSink | undefined;

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    onUpdate?: () => void,
    onLaneEvent?: (event: KubicLaneEvent) => void,
    // The session's committed spend, so the first live usage
    // event APPENDS to it instead of replacing the bar with the new row
    // alone (a resumed session's earlier turns are not re-emitted).
    usageRows: ReadonlyArray<StatusUsageRow> = [],
    // Per-turn spans; absent means the turn records none.
    spans?: TurnSpansSink,
    // The debug sink; absent drops the lines (the fault
    // notice below still renders — it does not need the sink).
    debug?: DebugSink,
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onUpdate = onUpdate;
    this.onLaneEvent = onLaneEvent;
    this.usageRows = [...usageRows];
    this.spans = spans;
    this.debug = debug;
    this.projector = new PresentationProjector(app.presentationSeed());
  }

  // The inbox carries submission ids, not prompt text —
  // the loop owns the text of the submissions it queued, so it hands its
  // in-place map in and the projector resolves `lane.queued` from it. The
  // state is then the ONE writer of the `queued:` rows: the app writes them
  // on every presentation apply instead of only on the two events that used
  // to re-sync them.
  setQueuedText(text: ReadonlyMap<string, string>): void {
    this.projector.setQueuedText(text);
  }

  // The queue map changed under the state (a submission
  // was just admitted), so hand the app the resolved state now — the state is
  // the only writer of the `queued:` rows, and without this the row would
  // wait for the next lane event.
  refreshPresentation(): void {
    this.app.applyPresentation(this.projector.state());
    this.onUpdate?.();
  }

  // The live model label (updated by a `/model` switch), so the
  // `/model` report and the headers never read a stale boot snapshot.
  get modelRef(): string {
    return this.model;
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

  // The live thinking level (the `pi.agent` document). Read once
  // from the lane, then kept by every switch — the status bar and the
  // `/thinking` report read the same value.
  private thinking: ModelThinkingLevel | undefined;

  get thinkingRef(): ModelThinkingLevel | undefined {
    return this.thinking;
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

  // The single lane-event consumer for this conversation (exactly
  // one). The committed entries the events carry are folded into the feed
  // (REPLACE on the attach snapshot, upsert on a committed message or tool
  // result) instead of re-reading the lane per event; tool status drives the
  // tree and usage rows drive the status bar.
  private readonly sink: LaneEventSink = (event: KubicLaneEvent): void => {
    // The loop's own bookkeeping runs FIRST: it owns the queue map the state
    // resolves `lane.queued` from (a `run-start` drops the id the harness just
    // placed), so folding before it would hand the app a row the placement
    // already consumed — and then no further event would clear it.
    this.onLaneEvent?.(event);
    // The projector folds the event; the app renders the
    // state it produces (the presentation never folds raw events).
    const revision = this.projector.revision();
    this.projector.apply(event);
    this.app.applyPresentation(this.projector.state());
    if (this.projector.revision() !== revision) {
      // The loop's bookkeeping above repaints
      // BEFORE this write (it owns the map the state resolves the queue
      // from), so the state the write produced needs a paint of its own —
      // without one a `queued:` row it just resolved only appears on the
      // next tick. Events that do not change the state (a `message-delta`,
      // a committed `entry`) keep their own paint paths.
      this.onUpdate?.();
    }
    if (event.type === 'run-start') {
      // The run is placed: a latched Ctrl-C may now abort it for real, and a
      // submission the harness queued earlier (a follow-up waiting behind a
      // failed run) counts as work in flight from this moment.
      this.markPlaced();
      this.markPlacedInputs(event.inputs);
      // The turn's run span opens on placement.
      this.spans?.turns.startRun(turnKey(event.inputs));
    }
    if (event.type === 'snapshot') {
      // REPLACE semantics: the attach snapshot is the transcript.
      // It is also the rebase — a consumer that fell behind the
      // watch gets a fresh snapshot, so the streamed draft is stale and goes.
      this.clearStream();
      this.replaceLaneEntries(event.entries);
      return;
    }
    if (event.type === 'message-delta') {
      // The in-flight generation's text, rendered as a draft
      // while it streams. The committed entry replaces it at
      // `message_end`, so this only ever appends to the draft.
      this.streamText += event.text;
      this.app.setStream(this.streamText);
      this.onUpdate?.();
      return;
    }
    if (event.type === 'usage') {
      // The row names the provider/model that answered; the status
      // bar reads tokens + cost only.
      // The same row feeds the [model] token line (sink
      // only — the status bar already shows the spend, so the transcript
      // stays quiet).
      this.usageRows.push({
        model: event.row.model,
        provider: event.row.provider,
        usage: event.row.usage,
        ...(event.row.entryId === undefined
          ? {}
          : { entryId: event.row.entryId }),
        ...(event.row.toolCallId === undefined
          ? {}
          : { toolCallId: event.row.toolCallId }),
      });
      this.app.setUsage([...this.usageRows]);
      this.debug?.(
        modelLine(
          event.row.usage.input,
          event.row.usage.output,
          event.row.usage.cacheRead,
          `${event.row.provider}/${event.row.model}`,
        ),
      );
      // The committed assistant entry is here. Clear the draft
      // FIRST — `clearStream` paints nothing, so no frame can show the text
      // vanishing — and fold second, because the fold's own paint is the one
      // frame that must carry the committed cell WITHOUT the draft beside it
      // (folding first would paint the just-committed text twice).
      this.clearStream();
      this.foldLaneEntries([event.entry]);
      return;
    }
    if (event.type === 'entry') {
      // A committed non-assistant entry (a compaction summary, a
      // reset handoff, a user turn) joins the transcript live.
      this.foldLaneEntries([event.entry]);
      return;
    }
    if (event.type === 'tool-start') {
      // The turn's tool span opens with the call.
      this.spans?.turns.startTool(event.toolCallId, event.toolName);
    }
    if (event.type === 'fault') {
      // A faulted harness task (pi-durable `task_failed` —
      // Pi 1.0 has no `handler_error` event) is the handler_error
      // line. It rides the debug sink when one is attached, and it ALWAYS
      // lands as a transcript notice: the TUI has no --debug channel, so
      // a silent sink would swallow an extension/hook failure whole.
      const line = hookErrorLine(event.code, event.message);
      this.debug?.(line);
      this.app.appendNotice([line]);
    }
    if (event.type === 'tool-end' && event.entry !== undefined) {
      // A tool result that faulted or was orphaned has no entry: the tree
      // already shows the error, and the transcript has nothing to append.
      this.foldLaneEntries([event.entry]);
    }
    if (event.type === 'tool-end') {
      // Entry or not, the call settled — a faulted or orphaned
      // call has no entry but its span still closes.
      this.spans?.turns.endTool(event.toolCallId, event.isError);
    }
    if (event.type === 'run-end') {
      // The turn settled — flush its artifact (run span plus
      // its tool spans). Telemetry never fails a turn.
      const spans = this.spans;
      if (spans !== undefined) {
        const artifact = spans.turns.endRun(turnKey(event.inputs));
        if (artifact !== undefined) {
          try {
            spans.write(artifact);
          } catch {
            // A failed artifact write is not a turn failure.
          }
        }
      }
    }
  };

  // The presentation state the app renders. Seeded from the app's own
  // session facts and fed every lane event the subscription delivers.
  private readonly projector: PresentationProjector;

  // The text streamed for the in-flight generation. Cleared when
  // the committed entry lands, on a snapshot rebase and at settlement.
  private streamText = '';

  private clearStream(): void {
    if (this.streamText === '') return;
    this.streamText = '';
    this.app.setStream(undefined);
  }

  private readonly usageRows: StatusUsageRow[];

  // The accumulated committed-transcript feed: the attach snapshot replaces
  // it, every later entry-bearing event upserts into it, and every apply is a
  // fresh snapshot for the app (revision semantics).
  private laneEntries: LaneEntryLike[] = [];
  private readonly laneEntryIndex = new Map<string, number>();

  private replaceLaneEntries(entries: readonly EntryRecord[]): void {
    this.laneEntries = [];
    this.laneEntryIndex.clear();
    this.foldLaneEntries(entries);
  }

  private foldLaneEntries(entries: readonly EntryRecord[]): void {
    for (const entry of entries) {
      const cell = laneEntryFor(entry);
      if (cell === undefined) continue;
      const id = String(cell.id);
      const at = this.laneEntryIndex.get(id);
      if (at === undefined) {
        this.laneEntryIndex.set(id, this.laneEntries.length);
        this.laneEntries.push(cell);
      } else {
        this.laneEntries[at] = cell;
      }
    }
    this.applyLaneEntries();
  }

  private applyLaneEntries(): void {
    // Every apply replaces the transcript's cells instead of appending them
    // (the app's revision counter makes the snapshot a replacement).
    this.app.applyLaneEntries(this.laneEntries);
    this.onUpdate?.();
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
          // `run-start` event below reports.
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
      // The subscription is snapshot-safe: the attach snapshot
      // replaces the feed, so nothing committed between the boot read and
      // this turn can be lost, and no event can arrive before the sink is
      // listening. ONE subscription serves the whole busy period.
      await this.ensureSubscription();
      const turn = await this.loop.runTurn(prompt, {
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
      this.clearStream();
      await this.refreshTranscript();
      // The lane's own terminal record is authoritative: an abort that raced
      // a completing turn must not be relabelled as cancelled (the work
      // really did land), and a turn the abort did stop settles 'aborted'.
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

  // The durable abort path: conversation.abort + the conversation's
  // kill drain. It THROWS when the abort or a kill fails, so the cancel path
  // reports a refusal instead of a silent no-op and the quit drain can bound
  // it. The abort targets the conversation, which is the only turn that can
  // be in flight here (the runner admits one turn at a time).
  private async abort(): Promise<void> {
    await this.loop.abort(this.loop.context);
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
    await this.abort();
    return true;
  }

  // Reads are tagged in issue order: a background refresh that resolves
  // after a newer one (e.g. the settlement refresh) is dropped instead of
  // overwriting the fresher feed.
  private readSeq = 0;
  private appliedSeq = 0;

  async refreshTranscript(): Promise<void> {
    this.readSeq += 1;
    const seq = this.readSeq;
    const entries = await this.loop.entries(this.loop.context);
    if (seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    // The accumulated event feed is the live transcript; a settling read
    // replaces it with the completed one (.5's readConversationEntries).
    this.replaceLaneEntries(entries);
  }
}
