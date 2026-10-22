// The views a turn's lane events feed: the presentation state the app
// renders, the draft of the generation in flight, the status bar's usage
// rows, and the committed transcript.
import type { KubicLaneEvent } from '@kubic/agent/lane/events';
import { redactSecrets } from '@kubic/agent/lane/interceptors';
import type { EntryRecord } from '@kubic/agent/pi-boundary';
import { PresentationProjector } from '@kubic/host/presentation';
import { type DebugSink, hookErrorLine, modelLine } from '@kubic/host/run';
import type { LaneEntryLike } from '@kubic/tui/lane-cells';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
import type { TuiApp } from '@kubic/tui/tui-app';
import { laneEntryFor } from './entries.js';

export class TuiTranscriptFeed {
  private readonly app: TuiApp;
  // Called after an apply lands (the root repaints).
  private readonly onUpdate: (() => void) | undefined;
  // The debug sink; absent drops the lines (the fault notice still
  // renders — it does not need the sink).
  private readonly debug: DebugSink | undefined;
  // The presentation state the app renders. Seeded from the app's own
  // session facts and fed every lane event the subscription delivers.
  private readonly projector: PresentationProjector;
  // The text streamed for the in-flight generation. Cleared when
  // the committed entry lands, on a snapshot rebase and at settlement.
  private streamText = '';
  private readonly usageRows: StatusUsageRow[];
  // The accumulated committed-transcript feed: the attach snapshot replaces
  // it, every later entry-bearing event upserts into it, and every apply is a
  // fresh snapshot for the app (revision semantics).
  private laneEntries: LaneEntryLike[] = [];
  private readonly laneEntryIndex = new Map<string, number>();
  // Reads are tagged in issue order: a background refresh that resolves
  // after a newer one (e.g. the settlement refresh) is dropped instead of
  // overwriting the fresher feed.
  private readSeq = 0;
  private appliedSeq = 0;

  constructor(
    app: TuiApp,
    // The session's committed spend, so the first live usage
    // event APPENDS to it instead of replacing the bar with the new row
    // alone (a resumed session's earlier turns are not re-emitted).
    usageRows: ReadonlyArray<StatusUsageRow>,
    onUpdate?: () => void,
    debug?: DebugSink,
  ) {
    this.app = app;
    this.usageRows = [...usageRows];
    this.onUpdate = onUpdate;
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

  // One committed lane event, folded into the views. The committed entries
  // the events carry are folded into the feed (REPLACE on the attach
  // snapshot, upsert on a committed message or tool result) instead of
  // re-reading the lane per event; usage rows drive the status bar.
  apply(event: KubicLaneEvent): void {
    // The projector folds the event; the app renders the
    // state it produces (the presentation never folds raw events).
    const revision = this.projector.revision();
    this.projector.apply(event);
    this.app.applyPresentation(this.projector.state());
    if (this.projector.revision() !== revision) {
      // The loop's bookkeeping repaints
      // BEFORE this write (it owns the map the state resolves the queue
      // from), so the state the write produced needs a paint of its own —
      // without one a `queued:` row it just resolved only appears on the
      // next tick. Events that do not change the state (a `message-delta`,
      // a committed `entry`) keep their own paint paths.
      this.onUpdate?.();
    }
    if (event.type === 'snapshot') {
      // REPLACE semantics: the attach snapshot is the transcript.
      // It is also the rebase — a consumer that fell behind the
      // watch gets a fresh snapshot, so the streamed draft is stale and goes.
      this.clearStream();
      this.replaceEntries(event.entries);
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
      this.applyUsage(event);
      return;
    }
    if (event.type === 'entry') {
      // A committed non-assistant entry (a compaction summary, a
      // reset handoff, a user turn) joins the transcript live.
      this.foldEntries([event.entry]);
      return;
    }
    if (event.type === 'fault') {
      // A faulted harness task (pi-durable `task_failed` —
      // Pi 1.0 has no `handler_error` event) is the handler_error
      // line. It rides the debug sink when one is attached, and it ALWAYS
      // lands as a transcript notice: the TUI has no --debug channel, so
      // a silent sink would swallow an extension/hook failure whole. The
      // message is a raw task error, so secret-shaped values are redacted
      // before it reaches the screen, like an approval summary.
      const line = hookErrorLine(event.code, redactSecrets(event.message));
      this.debug?.(line);
      this.app.appendNotice([line]);
    }
    if (event.type === 'tool-end' && event.entry !== undefined) {
      // A tool result that faulted or was orphaned has no entry: the tree
      // already shows the error, and the transcript has nothing to append.
      this.foldEntries([event.entry]);
    }
  }

  // The row names the provider/model that answered; the status
  // bar reads tokens + cost only. The same row feeds the [model] token line
  // (sink only — the status bar already shows the spend, so the transcript
  // stays quiet).
  private applyUsage(event: Extract<KubicLaneEvent, { type: 'usage' }>): void {
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
    this.foldEntries([event.entry]);
  }

  clearStream(): void {
    if (this.streamText === '') return;
    this.streamText = '';
    this.app.setStream(undefined);
  }

  // The accumulated event feed is the live transcript; a settling read
  // replaces it with the completed one.
  async refresh(
    read: () => Promise<ReadonlyArray<EntryRecord>>,
  ): Promise<void> {
    this.readSeq += 1;
    const seq = this.readSeq;
    const entries = await read();
    if (seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    this.replaceEntries(entries);
  }

  private replaceEntries(entries: readonly EntryRecord[]): void {
    this.laneEntries = [];
    this.laneEntryIndex.clear();
    this.foldEntries(entries);
  }

  private foldEntries(entries: readonly EntryRecord[]): void {
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
    // Every apply replaces the transcript's cells instead of appending them
    // (the app's revision counter makes the snapshot a replacement).
    this.app.applyLaneEntries(this.laneEntries);
    this.onUpdate?.();
  }
}
