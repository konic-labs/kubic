// The turn the app shows: busy, cancelling and failed; each call's timing;
// the receipts of settled turns; the committed lane entries; the echo of a
// prompt the lane has not committed yet; and the commands' own notices.
import type {
  KubicPresentationState,
  LaneImagePart,
} from '@kubic/core/presentation';
import { keyCap, sessionTitle } from '../chrome.js';
import type { WorkingInfo } from '../editor-frame.js';
import {
  entriesToCells,
  type LaneEntryLike,
  PROMPT_PREFIX,
} from '../lane-cells.js';
import { sanitizeLaneText } from '../lane-text.js';
import { parseSlashCommand } from '../slash-commands.js';
import type { StatusTurnState } from '../status-bar.js';
import type {
  ToolCallState,
  TranscriptEntry,
  TurnReceipt,
} from '../transcript.js';
import { applyTreeSnapshot } from '../tree.js';
import type { JournalChangeLike } from '../view-panel.js';
import type { AppCore } from './core.js';
import { laneActivityLine } from './notice-row.js';

// A thinking cell's generation time is measured only for entries
// this app saw arrive live, and only when the gap is plausible (a resumed
// session's old entries would otherwise read as hours of thought).
const THINKING_MEASURE_MAX_MS = 10 * 60_000;

interface ToolTime {
  readonly seenAt: number;
  readonly toolName: string;
  readonly running: boolean;
  readonly durationMs?: number;
}

export class TurnView {
  private readonly core: AppCore;
  busy = false;
  // The status line's state word inputs — a cancel the loop
  // asked for, and whether the last settled turn failed.
  cancelling = false;
  failed = false;
  private revision = 0;
  // A command's own output (`/help`, `/session`, `/undo`) lands
  // as transcript text through its own lane/revision pair, so a later lane
  // snapshot replaces it.
  private noticeRevision = 0;
  private noticeCells: TranscriptEntry[] = [];
  private pendingPrompt: string | undefined;
  // The images the next echoed prompt carries. The loop sets
  // them on the same keystroke as the submit it accepted, the echo renders
  // them, and clearing the echo clears them.
  private pendingImages: readonly LaneImagePart[] = [];
  // Enter with an attachment and no text IS a submit —
  // the image is the prompt. The editor asks this before dropping a blank
  // draft (attach + Enter was a silent no-op otherwise). The count is the
  // loop's UNSUBMITTED attachments, not the echo images: after a submit the
  // echo still holds them, and a blank Enter there must stay a no-op.
  pendingAttachments = 0;
  private promptCells = 0;
  private promptCellsAtSubmit = 0;
  // This turn's facts for the working line — the usage rows and
  // tool cells that arrived since the turn started.
  private turnRowsBase = 0;
  private toolCells = 0;
  private turnToolsBase = 0;
  // What the presentation state says about each call — when the
  // app first saw it, whether it still runs, and its duration once done.
  // Kept across turns (the lane snapshot folds completed turns away).
  private readonly toolTimes = new Map<string, ToolTime>();
  // Thinking times (null: seen in loaded history, unmeasured),
  // the receipts of turns settled in this process, and what they count from.
  private readonly thinkingTimes = new Map<string, number | null>();
  private historyPending = true;
  private receipts: Array<{
    readonly afterPrompts: number;
    readonly cell: TranscriptEntry;
  }> = [];
  private receiptCount = 0;
  private lastLaneCells: TranscriptEntry[] = [];
  private receiptBase = { at: Date.now(), rows: 0 };
  private journalRows: ReadonlyArray<JournalChangeLike> = [];

  constructor(core: AppCore) {
    this.core = core;
  }

  // What the status line's state word and the key-hint row
  // follow. An approval outranks everything: it is what the turn waits on.
  turnState(): StatusTurnState {
    if (this.core.approvalSurface.isShowing()) return 'approval';
    if (this.busy) return this.cancelling ? 'cancelling' : 'working';
    return this.failed ? 'error' : 'ready';
  }

  // The working line's facts: this turn's tokens and tool calls, and the
  // key that interrupts it.
  workingInfo(): Omit<WorkingInfo, 'elapsedMs'> {
    const rows = this.core.status.getState().rows.slice(this.turnRowsBase);
    let input = 0;
    let output = 0;
    for (const row of rows) {
      input += row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
      output += row.usage.output;
    }
    return {
      ...(rows.length === 0 ? {} : { input, output }),
      tools: this.toolCells - this.turnToolsBase,
      interruptKey: keyCap(this.core.keys.label('app.cancel')),
    };
  }

  toolStateOf(toolCallId: string): ToolCallState | undefined {
    const time = this.toolTimes.get(toolCallId);
    if (time === undefined) return undefined;
    return {
      ...(time.durationMs === undefined ? {} : { durationMs: time.durationMs }),
      ...(time.running ? { runningMs: Date.now() - time.seenAt } : {}),
      ...(this.waitingToolCallId() === toolCallId ? { waiting: true } : {}),
    };
  }

  // The call an approval holds: the newest running call of the asking tool
  // (the lane runs one challenged call at a time).
  private waitingToolCallId(): string | undefined {
    const request = this.core.approvalSurface.pending();
    if (request === undefined) return undefined;
    let found: string | undefined;
    for (const [id, time] of this.toolTimes) {
      if (time.running && time.toolName === request.toolName) found = id;
    }
    return found;
  }

  // The loop decides which submit outcome this is. A queued
  // follow-up must not render as a pending turn (the queued row is its
  // feedback), and a refused prompt must not either — the loop's footer
  // says why. Both still pin the transcript: the operator asked to see
  // the tail.
  submit(prompt: string): void {
    const { core } = this;
    const handler = core.submitHandler;
    if (handler === undefined) return;
    const outcome = handler(prompt) ?? 'accepted';
    if (outcome !== 'refused') core.palette.noteRecentCommand(prompt);
    // The first prompt (not a command) clears the first screen.
    if (outcome === 'accepted' && parseSlashCommand(prompt) === undefined) {
      core.session.hideWelcome();
    }
    if (outcome === 'refused') {
      // A refused prompt never eats the draft. Pi's
      // editor clears the draft BEFORE onSubmit fires, so the text has to go
      // back — the footer says why it was refused, and the operator can fix
      // the draft instead of retyping it.
      this.restoreDraft(prompt);
      return;
    }
    if (outcome === 'accepted') this.echoPendingPrompt(prompt);
    core.transcript.rePin();
  }

  // Put a draft the loop refused back in the editor.
  restoreDraft(prompt: string): void {
    this.core.editor.setText(prompt);
    this.core.transcript.rePin();
  }

  // The prompt echo before the lane commits it, also reused for
  // a queued follow-up whose turn has started.
  private echoPendingPrompt(prompt: string): void {
    this.pendingPrompt = sanitizeLaneText(prompt);
    this.promptCellsAtSubmit = this.promptCells;
    this.core.transcript.setPendingPrompt(
      this.pendingPrompt,
      this.pendingImages,
    );
  }

  setPendingEcho(prompt: string | undefined): void {
    if (prompt === undefined) {
      this.clearEcho();
      return;
    }
    this.echoPendingPrompt(prompt);
    this.core.transcript.rePin();
  }

  // The attachments the next echo carries. The loop sets them
  // as part of the submit it accepted, so the echoed prompt renders the
  // images the lane was actually given.
  setPendingImages(images: readonly LaneImagePart[]): void {
    this.pendingImages = images;
    if (this.pendingPrompt !== undefined) {
      this.core.transcript.setPendingPrompt(
        this.pendingPrompt,
        this.pendingImages,
      );
    }
  }

  private clearEcho(): void {
    this.pendingPrompt = undefined;
    this.pendingImages = [];
    this.core.transcript.setPendingPrompt(undefined);
  }

  setBusy(next: boolean): void {
    const { core } = this;
    if (next && !this.busy) {
      this.receiptBase = {
        at: Date.now(),
        rows: core.status.getState().rows.length,
      };
    }
    this.busy = next;
    // A settled turn ends any cancel; a new one clears the
    // last turn's error.
    this.cancelling = false;
    if (next) this.failed = false;
    if (next) {
      this.turnRowsBase = core.status.getState().rows.length;
      this.turnToolsBase = this.toolCells;
    }
    core.quit.disarm();
    // The editor stays ENABLED through a turn. Enter is no
    // longer a silent no-op while the lane works: the loop submits it as
    // a follow-up into the conversation's inbox, and Alt+Enter steers.
    core.noticeRow.busySince = next ? Date.now() : undefined;
    core.noticeRow.setFooter('');
    if (!next && this.pendingPrompt !== undefined) this.clearEcho();
  }

  setCancelling(next: boolean): void {
    this.cancelling = this.busy && next;
  }

  busyElapsedMs(now: number): number | undefined {
    const since = this.core.noticeRow.busySince;
    return since === undefined ? undefined : Math.max(0, now - since);
  }

  // A turn ends with its receipt.
  setTurnOutcome(
    outcome: 'completed' | 'cancelled' | 'failed',
    info: { readonly startedAt?: number; readonly detail?: string },
  ): void {
    const { core } = this;
    this.failed = outcome === 'failed';
    this.cancelling = false;
    const now = Date.now();
    const start = Math.max(
      info.startedAt ?? this.receiptBase.at,
      this.receiptBase.at,
    );
    const rows = core.status.getState().rows;
    const changed = this.journalRows.filter((row) => row.timestamp >= start);
    const files = new Set(changed.map((row) => row.path)).size;
    const counts = journalLineCounts(changed);
    const detail = info.detail?.split('\n', 1)[0]?.trim();
    const receipt: TurnReceipt = {
      outcome,
      elapsedMs: Math.max(0, now - start),
      tools: [...this.toolTimes.values()].filter((time) => time.seenAt >= start)
        .length,
      files,
      ...(counts === undefined ? {} : counts),
      costUsd: rows
        .slice(this.receiptBase.rows)
        .reduce((sum, row) => sum + row.usage.cost.total, 0),
      ...(detail === undefined || detail === ''
        ? {}
        : { detail: sanitizeLaneText(detail) }),
      diffKey: keyCap(core.keys.label('panel.diff')),
    };
    this.receiptCount += 1;
    this.receipts.push({
      afterPrompts: this.promptCells,
      cell: {
        id: `${core.session.sessionId}:receipt:${this.receiptCount}`,
        kind: 'receipt',
        markdown: '',
        receipt,
      },
    });
    this.receiptBase = { at: now, rows: rows.length };
    this.revision += 1;
    core.transcript.applyLaneSnapshot(
      { laneId: core.session.sessionId },
      this.withReceipts(this.lastLaneCells),
      this.revision,
    );
  }

  setJournalRows(rows: ReadonlyArray<JournalChangeLike>): void {
    this.journalRows = rows;
  }

  applyPresentation(state: KubicPresentationState): void {
    const { core } = this;
    const lane = state.lane;
    core.noticeRow.setActivity(laneActivityLine(lane));
    applyTreeSnapshot(core.tree.getState(), {
      status: lane.status,
      tools: lane.tools,
      usage: {
        costTotal: state.usage.costUsd,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
      },
    });
    core.transcript.setQueuedPrompts(lane.queued);
    // The cards' facts. A call that left the snapshot while
    // still marked running was cut off with its turn: it runs no more.
    const live = new Set<string>();
    for (const tool of lane.tools) {
      live.add(tool.toolCallId);
      const known = this.toolTimes.get(tool.toolCallId);
      const durationMs = tool.durationMs ?? known?.durationMs;
      this.toolTimes.set(tool.toolCallId, {
        seenAt: known?.seenAt ?? Date.now(),
        toolName: tool.toolName,
        running: tool.status === 'running',
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
    for (const [id, time] of this.toolTimes) {
      if (time.running && !live.has(id)) {
        this.toolTimes.set(id, { ...time, running: false });
      }
    }
    // The diff panel follows the run: the newest call of the lane is
    // what "the current run's changes" means, so the panel's default
    // selection tracks it (an explicit setDiffToolCall still wins).
    const last = lane.tools.at(-1);
    if (last !== undefined)
      core.panel.diffPanel.followToolCall(last.toolCallId);
    // The state's session facts are the SEED — the
    // lane the boot selected — and the projector never updates them from
    // events. Writing them back here would silently revert the posture the
    // installed policy reports; the app owns it, and a consumer that wants
    // the live value reads the status bar.
  }

  applyLaneEntries(entries: ReadonlyArray<LaneEntryLike>): void {
    const { core } = this;
    // The revision counter makes every apply a fresh snapshot: the
    // transcript replaces its cells instead of appending duplicates.
    this.revision += 1;
    const cells = this.timedCells(entries);
    this.historyPending = false;
    this.lastLaneCells = cells;
    core.transcript.applyLaneSnapshot(
      { laneId: core.session.sessionId },
      this.withReceipts(cells),
      this.revision,
    );
    // A lane snapshot is the session's own transcript, so the command
    // notices stop being it (a stale notice list must never be
    // re-applied by the next `/help`).
    this.noticeCells = [];
    // The echoed prompt is dropped once the lane has committed a NEW
    // prompt cell (counted, not matched by text: an identical resubmit
    // must not clear on the previous turn's cell).
    this.promptCells = cells.filter((cell) => cell.kind === 'prompt').length;
    this.toolCells = cells.filter((cell) => cell.kind === 'tool').length;
    // A session with history never shows the first screen.
    if (this.promptCells > 0) core.session.hideWelcome();
    if (core.session.title === undefined) {
      const first = cells
        .filter((cell) => cell.kind === 'prompt')
        .map((cell) =>
          cell.markdown.startsWith(PROMPT_PREFIX)
            ? cell.markdown.slice(PROMPT_PREFIX.length)
            : cell.markdown,
        )
        .find((text) => text.trim() !== '');
      if (first !== undefined) core.session.title = sessionTitle(first);
    }
    if (
      this.pendingPrompt !== undefined &&
      this.promptCells > this.promptCellsAtSubmit
    ) {
      this.clearEcho();
    }
  }

  // The lane's cells, each thinking cell with its generation time when
  // this app saw it arrive live.
  private timedCells(entries: ReadonlyArray<LaneEntryLike>): TranscriptEntry[] {
    const now = Date.now();
    return entriesToCells(entries).map((cell) => {
      if (cell.kind !== 'thinking') return cell;
      let time = this.thinkingTimes.get(cell.id);
      if (time === undefined) {
        const gap =
          cell.timestamp === undefined ? undefined : now - cell.timestamp;
        time =
          !this.historyPending &&
          gap !== undefined &&
          gap >= 0 &&
          gap < THINKING_MEASURE_MAX_MS
            ? gap
            : null;
        this.thinkingTimes.set(cell.id, time);
      }
      return time === null ? cell : { ...cell, durationMs: time };
    });
  }

  // A receipt sits before the first prompt committed after its turn settled
  // — a late entry event can never push it above the turn's own answer.
  private withReceipts(cells: TranscriptEntry[]): TranscriptEntry[] {
    const receipts = this.receipts;
    if (receipts.length === 0) return cells;
    const out: TranscriptEntry[] = [];
    let prompts = 0;
    let next = 0;
    for (const cell of cells) {
      if (cell.kind === 'prompt') {
        prompts += 1;
        while (
          next < receipts.length &&
          (receipts[next]?.afterPrompts ?? 0) < prompts
        ) {
          out.push((receipts[next] as { cell: TranscriptEntry }).cell);
          next += 1;
        }
      }
      out.push(cell);
    }
    while (next < receipts.length) {
      out.push((receipts[next] as { cell: TranscriptEntry }).cell);
      next += 1;
    }
    return out;
  }

  appendNotice(lines: ReadonlyArray<string>): void {
    const { core } = this;
    const clean = lines
      .map((line) => sanitizeLaneText(line))
      .filter((line) => line !== '');
    if (clean.length === 0) return;
    this.noticeRevision += 1;
    this.noticeCells = [
      ...this.noticeCells,
      {
        id: `${core.session.sessionId}:notice:${this.noticeRevision}`,
        kind: 'text',
        markdown: clean.join('\n'),
      },
    ];
    core.transcript.applyLaneSnapshot(
      { laneId: `${core.session.sessionId}:notice` },
      this.noticeCells,
      this.noticeRevision,
    );
    core.transcript.rePin();
  }

  // `/new` and `/resume`: the turn facts start over for the next session.
  reset(sessionId: string, usageRows: number): void {
    const { core } = this;
    this.revision += 1;
    core.transcript.applyLaneSnapshot({ laneId: sessionId }, [], this.revision);
    this.noticeCells = [];
    this.pendingPrompt = undefined;
    this.promptCells = 0;
    this.promptCellsAtSubmit = 0;
    core.transcript.setPendingPrompt(undefined);
    core.transcript.setQueuedPrompts([]);
    core.tree.reset(undefined, true);
    core.session.title = undefined;
    this.toolTimes.clear();
    this.thinkingTimes.clear();
    this.historyPending = true;
    this.receipts = [];
    this.lastLaneCells = [];
    this.journalRows = [];
    this.receiptBase = { at: Date.now(), rows: usageRows };
    this.toolCells = 0;
    this.turnToolsBase = 0;
    this.turnRowsBase = 0;
    this.failed = false;
    this.cancelling = false;
  }
}

// Lines added and removed across a turn's journal rows — a
// multiset count (exact for the usual in-place edit), nothing when the
// content is unknown on both sides.
function journalLineCounts(
  rows: ReadonlyArray<JournalChangeLike>,
): { readonly added: number; readonly removed: number } | undefined {
  let added = 0;
  let removed = 0;
  let known = false;
  for (const row of rows) {
    if (row.before === null && row.after === null) continue;
    known = true;
    // A final newline ends the last line; it is not an empty line.
    const lines = (text: string | null): string[] =>
      text === null || text === ''
        ? []
        : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
    const before = lines(row.before);
    const after = lines(row.after);
    const pool = new Map<string, number>();
    for (const line of before) pool.set(line, (pool.get(line) ?? 0) + 1);
    for (const line of after) {
      const left = pool.get(line) ?? 0;
      if (left > 0) pool.set(line, left - 1);
      else added += 1;
    }
    for (const left of pool.values()) removed += left;
  }
  return known ? { added, removed } : undefined;
}
