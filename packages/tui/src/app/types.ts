// The contracts of the interactive TUI app: what the composition root seeds
// it with, what it hands back for a key, and the app's own API.

import type {
  KubicPresentationState,
  LaneImagePart,
} from '@kubic/core/presentation';
import type { ApprovalSurface } from '../approval-surface.js';
import type {
  ApprovalDecision,
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from '../approval-view.js';
import type { PromptEditor } from '../editor-view.js';
import type { KeyRegistry } from '../keybindings.js';
import type { LaneEntryLike } from '../lane-cells.js';
import type { TreeEntryLike } from '../session-tree.js';
import type { StatusBar, StatusUsageRow } from '../status-bar.js';
import type { TranscriptView } from '../transcript.js';
import type { TreeView } from '../tree.js';
import type { AutocompleteProvider, VStack } from '../tui-boundary.js';
import type { JournalChangeLike, PanelMode } from '../view-panel.js';

// The request the overlay answers: approval-view.ts's own request shape, named
// here so the composition root and the app agree on one type.
export type TuiApprovalRequest = ApprovalViewRequest;

// The header's workspace facts, read by the composition root
// (the TUI package runs no git of its own).
export interface TuiWorkspace {
  /** Basename of the project root. */
  readonly project: string;
  /** Current branch; absent outside a repository. */
  readonly branch?: string;
  /** Changed files in the working tree. */
  readonly dirty?: number;
}

// The facts only the composition root has for the preflight; the app supplies
// the model, workspace and keys.
interface TuiPreflightSeed {
  readonly version?: string;
  /** Where a provider's key comes from (`ANTHROPIC_API_KEY`). */
  readonly keySource?: (provider: string) => string | undefined;
  /** The testing model (`faux/echo`): no model is called. */
  readonly testingModel?: string;
  /** The project layer's trust state; absent when the project has none. */
  readonly trust?: 'loaded' | 'untrusted';
  /** The isolation sentence. */
  readonly isolation?: () => string;
}

// One recent session on the first screen.
export interface TuiRecentSession {
  readonly title: string;
  readonly age: string;
  readonly detail: string;
}

export interface TuiAppSeed {
  readonly sessionId: string;
  readonly model: string;
  readonly thinking?: string;
  readonly label?: string;
  // The approval surface to collect verdicts with. The composition
  // root creates it BEFORE the lane boots (the boot installs the policy that
  // consults it as the seat) and passes the same object here, so the surface
  // the operator sees IS the surface the lane asks. Absent means a private
  // one — the viewer shell (`kubic tui` with an injected boot) still renders
  // an ask inline instead of hanging.
  readonly approvalSurface?: ApprovalSurface;
  // The always-visible posture indicator. REQUIRED —
  // seeded from the posture the composition root actually installed — so no
  // call site can silently default a full-access session to 'approvals:on'.
  readonly approvalsSkipped: boolean;
  // The boot model's context window and the token level at
  // which the lane compacts. Absent when the catalog does not know the
  // window — the context gauge then stays off.
  readonly contextWindow?: number;
  readonly compactionThreshold?: number;
  // The keybinding registry — defaults plus the
  // user's ~/.kubic/keybindings.json overrides, resolved by the composition
  // root. Every key the app claims ahead of the editor is looked up here.
  readonly keys?: KeyRegistry;
  // The workspace files `@` mentions complete from — the
  // composition root's gitignore-aware walk. Absent: slash commands only.
  readonly listFiles?: () => readonly string[];
  // The booted (gated-visible, hidden included) skill
  // names — the composition root threads them so `/skill:<prefix>`
  // completes to `/skill:<name>`. Absent means no per-skill rows.
  readonly skillNames?: readonly string[];
  // The header's project / branch / dirty count (setWorkspace
  // refreshes it after a settled turn).
  readonly workspace?: TuiWorkspace;
  // The header clock (`HH:MM`); absent leaves it off.
  readonly clock?: () => string;
  // The honest lane notice, shown in the welcome block ('' when
  // suppressed). The composition root owns the text.
  readonly laneNotice?: () => string;
  // What the first screen's preflight needs from the boot.
  readonly preflight?: TuiPreflightSeed;
  // Copy text to the system clipboard (OSC 52, written by the
  // composition root). False when this terminal does not take it.
  readonly clipboard?: (text: string) => boolean;
  // Whether an `allow all edits this turn` answer applies now
  // (the policy's own state), for the status line.
  readonly editsApprovedThisTurn?: () => boolean;
  // The project's absolute root; with `listFiles`, file
  // references in answers link to `file://<root>/<path>`.
  readonly fileRoot?: string;
  // The workspace as the approval card shows it (`~/proj`).
  readonly cwdLabel?: string;
}

export interface TuiInputResult {
  readonly quit: boolean;
  readonly consumed: boolean;
  // Ctrl-C during a turn aborts the operation instead of
  // exiting. The root owns the busy/idle decision; the app only
  // classifies the key, so the count and the exit stay in one place.
  readonly cancel: boolean;
  // Alt+Enter handed the app a non-empty draft as a steer. The
  // app has already cleared the editor; the loop decides what the text
  // becomes (steer the running turn, or submit it when idle), because only
  // the loop knows a lane and its busy state.
  readonly steer?: string;
  // Alt+M opens the model picker (the loop supplies the rows).
  readonly pickModel?: boolean;
  // Alt+T cycles the thinking level over what the live model
  // supports (the loop owns the ladder and the commit).
  readonly cycleThinking?: boolean;
  // Ctrl-P opens the command palette (the loop supplies the
  // registry rows and dispatches the chosen command).
  readonly palette?: boolean;
  // Alt+A toggles full access for this session (the loop owns
  // the confirmation, the posture write and the indicator).
  readonly fullAccess?: boolean;
  // Esc during a turn — interrupt it, and never quit (a second
  // Esc while the interrupt drains is a no-op, unlike Ctrl-C).
  readonly interrupt?: boolean;
}

// What the loop did with a submitted prompt. `queued` means the follow-up went
// into the conversation's inbox (pi-durable `whenBusy: 'followUp'`) — the app
// must NOT echo it as a pending turn; the queued row does that. `refused` means
// no lane could take it at all (the session has no lane); the loop has put the
// reason on the footer. adds `command`: the draft was a TUI command (`/image`),
// which ran — nothing is echoed and nothing is restored.
export type TuiSubmitOutcome = 'accepted' | 'queued' | 'refused' | 'command';

// The keys handleInput claims before the editor live in the keybinding
// registry (keybindings.ts): each default there carries the probe
// that shows Pi's editor and alt-screen leave it free.

// One row of the `/model` picker overlay. `label` is the
// `provider/id` the operator sees and the value the loop resolves.
export interface TuiModelPickerRow {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  /** Marked as the live model (the picker highlights it). */
  readonly current?: boolean;
  /** A short note (provider origin). */
  readonly note?: string;
  /** The row's `200k ctx · thinking`. */
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  /** The thinking levels the model supports (the picker's thinking row). */
  readonly thinking?: readonly string[];
}

// A provider's header in the model picker. A provider without
// a key is listed with what to set, its models never offered.
export interface TuiModelPickerProvider {
  readonly id: string;
  readonly usable: boolean;
  /** Where its key comes from (`ANTHROPIC_API_KEY`). */
  readonly keySource?: string;
  /** What to set when it has none (`OPENAI_API_KEY`). */
  readonly keyVar?: string;
}

// The generic picker (the model picker, the command palette and
// the session list all render through it).
export interface TuiPickerRow {
  readonly value: string;
  readonly label: string;
  /** Right-aligned (`2m ago · 4 turns · $0.03`). */
  readonly description?: string;
  /** Start the list on this row (the live model, the current session). */
  readonly current?: boolean;
  /** Shown greyed and never chosen, with why (for example, a session another kubic holds). */
  readonly disabled?: boolean;
  readonly note?: string;
}

export interface TuiPickerOptions {
  /** The frame's title (`Session`, `Theme`). */
  readonly title?: string;
  readonly rows: readonly TuiPickerRow[];
  readonly onSelect: (value: string) => void;
  readonly onCancel?: () => void;
  /** The selection moved (the theme picker previews it). */
  readonly onMove?: (value: string | undefined) => void;
}

// The ^P palette's sources. The app owns the command rows (the
// registry), the file rows (`listFiles`) and what they do in the editor;
// the composition root supplies the rows only it can read and the actions
// only it can take. Models and sessions load after the palette opens.
export interface TuiPaletteModel {
  readonly provider: string;
  readonly id: string;
  readonly current: boolean;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
}

export interface TuiPaletteSession {
  readonly id: string;
  /** Its first prompt; the id when absent. */
  readonly title?: string;
  /** When the session was created (ISO), shown as its age. */
  readonly createdAt?: string;
  readonly turns?: number;
}

export interface TuiPaletteSources {
  readonly models?: () => Promise<readonly TuiPaletteModel[]>;
  readonly sessions?: () => Promise<readonly TuiPaletteSession[]>;
  /** Run a command row as if it had been typed (`/help`). */
  readonly runCommand: (command: string) => void;
  readonly switchModel?: (provider: string, id: string) => void;
  readonly resumeSession?: (id: string) => void;
  readonly onCancel?: () => void;
}

// The confirmation dialog (the full-access toggle's "are you
// sure?"). The accept key is explicit and deliberate — never a bare
// printable letter — and every other key is swallowed while it shows, so
// text typed ahead in the editor can never accept it.
export interface TuiSessionTreeOptions {
  /** The session's entries, parents first. */
  readonly entries: readonly TreeEntryLike[];
  /** The entry the session is at. */
  readonly currentId: string | null;
  /** Where the selection starts (default: the current entry). */
  readonly selectedId?: string;
  readonly onSelect: (entry: TreeEntryLike) => void;
  readonly onCancel?: () => void;
  /** A label saved, or removed (`undefined`), on an entry. */
  readonly onLabel?: (entryId: string, label: string | undefined) => void;
}

export interface TuiConfirmOptions {
  readonly title: string;
  readonly body: readonly string[];
  /** The key id that accepts (`'ctrl+s'`); everything else is ignored. */
  readonly confirmKey: string;
  /** Its label for the hint row (`'Ctrl-S'`). */
  readonly confirmLabel: string;
  /** What accepting does, on its key cap (`'turn off'`); default `confirm`. */
  readonly confirmAction?: string;
  /** What cancelling keeps, on the Esc cap (`'keep on'`); default `cancel`. */
  readonly cancelAction?: string;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

export interface TuiModelPickerOptions {
  readonly rows: readonly TuiModelPickerRow[];
  /** Every provider, keyless ones included (headers only). */
  readonly providers?: readonly TuiModelPickerProvider[];
  /** The live thinking level: where the thinking row starts. */
  readonly thinking?: string;
  /** The chosen model and the thinking level chosen with it. */
  readonly onSelect: (row: TuiModelPickerRow, thinking?: string) => void;
  readonly onCancel?: () => void;
}

export interface TuiApp {
  readonly root: VStack;
  readonly tree: TreeView;
  readonly transcript: TranscriptView;
  readonly status: StatusBar;
  readonly editor: PromptEditor;
  render(width: number): string[];
  handleInput(data: string): TuiInputResult;
  finalDocument(width: number): string[];
  // The app renders from replicated presentation state —
  // the projector folds the lane events, the app never sees them.
  applyPresentation(state: KubicPresentationState): void;
  // The seed the host-side projector starts from (the app owns the live
  // session facts the state mirrors).
  presentationSeed(): {
    sessionId: string;
    model: string;
    approvalsSkipped: boolean;
  };
  applyLaneEntries(entries: ReadonlyArray<LaneEntryLike>): void;
  setUsage(rows: ReadonlyArray<StatusUsageRow>): void;
  // The live model label the header, welcome block and status
  // bar show. Called after a `/model` switch lands; presentation only — the
  // lane switch itself happens through the lane's own setModel.
  setModel(model: string, thinking?: string): void;
  // The context gauge follows a `/model` switch. The limits are
  // the NEW model's window and compaction threshold; a model whose window is
  // unknown clears them, so the gauge disappears rather than showing the old
  // model's percentage.
  setContextLimits(limits: {
    contextWindow?: number;
    compactionThreshold?: number;
  }): void;
  // The context gauge's reading: the size of the context the next request
  // carries, re-measured by the root after every commit.
  setContextTokens(tokens: number): void;
  onSubmit(handler: (prompt: string) => TuiSubmitOutcome | undefined): void;
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  // The transient notice row above the editor. Empty clears it.
  setEditorFooter(text: string): void;
  // The status line's state word. A cancel the loop asked for
  // reads `cancelling…` until the turn settles; a failed turn reads `error`
  // until the next one starts.
  setCancelling(cancelling: boolean): void;
  // The settled turn's start (submission) and failure text feed
  // its receipt; a turn ends with one.
  setTurnOutcome(
    outcome: 'completed' | 'cancelled' | 'failed',
    info?: { readonly startedAt?: number; readonly detail?: string },
  ): void;
  // The header's project / branch / dirty count.
  setWorkspace(workspace: TuiWorkspace): void;
  // The echo row for a prompt whose turn has STARTED but whose
  // user entry is not committed yet — a queued follow-up the inbox placed.
  // A later committed prompt cell clears it, exactly like a direct submit.
  setPendingEcho(prompt: string | undefined): void;
  // The editor's autocomplete (the registry's `/` commands).
  setAutocomplete(provider: AutocompleteProvider): void;
  // The model picker (model.select). The loop supplies the
  // catalog rows and handles the choice; the app owns the overlay, the
  // modal input and the cancel. Returns false when this boot has no overlay
  // seat (the loop then reports it on the footer instead of failing silent).
  openModelPicker(options: TuiModelPickerOptions): boolean;
  /** Whether the picker overlay is showing (the loop refuses nested keys). */
  isModelPickerOpen(): boolean;
  // The same overlay for the command palette and the session
  // list; `openModelPicker` is this with the model rows mapped.
  openPicker(options: TuiPickerOptions): boolean;
  // ^P's grouped palette. False when this boot has
  // no overlay seat or the terminal is too narrow (the loop says so).
  openPalette(sources: TuiPaletteSources): boolean;
  isPaletteOpen(): boolean;
  // This project's recent sessions on the first screen.
  setRecentSessions(sessions: readonly TuiRecentSession[]): void;
  // `?` — every key binding, grouped (also reachable here).
  openKeysOverlay(): boolean;
  // A command's own output (the `/help` list, `/session`,
  // `/undo`'s verdict) as transcript text. A later lane snapshot replaces
  // it.
  appendNotice(lines: ReadonlyArray<string>): void;
  // `/session` — id, workspace, model, thinking level, tokens and
  // cost from the rows the status bar already carries (one source of truth).
  // `cwd` comes from the boot (the app never guesses a workspace).
  sessionReport(cwd?: string): string;
  // `/new` and `/resume` — clear every session-scoped surface
  // (transcript, tree, usage, panels, echoes) and take the next session's
  // identity, without recreating the app.
  resetSession(options: {
    readonly sessionId: string;
    readonly model: string;
    readonly thinking?: string;
    readonly usage?: ReadonlyArray<StatusUsageRow>;
  }): void;
  // The confirmation dialog (the full-access toggle). Returns
  // false when this boot has no overlay seat.
  openConfirm(options: TuiConfirmOptions): boolean;
  /** Whether a confirmation is showing (a public accessor for embedders). */
  isConfirmOpen(): boolean;
  // `/tree`: the session tree in the editor's place until an entry is
  // chosen (Enter) or it is closed (Esc).
  openSessionTree(options: TuiSessionTreeOptions): void;
  isSessionTreeOpen(): boolean;
  // The images the next echoed prompt carries, set by
  // the loop together with the submit it accepted.
  setPendingImages(images: readonly LaneImagePart[]): void;
  // How many attachments are armed but NOT yet
  // submitted — the signal `allowEmptySubmit` reads. `setPendingImages` is
  // the echo's copy and outlives the submit; this one is cleared by the
  // submit itself.
  setPendingAttachments(count: number): void;
  // Put a refused draft back in the editor, so a
  // `/model` typed mid-turn never eats the text the operator typed.
  restoreDraft(prompt: string): void;
  // Ms since the in-flight turn started (undefined when idle); the root's
  // spinner timer re-renders while this is defined.
  busyElapsedMs(now?: number): number | undefined;
  // Ctrl-X: expand / collapse tool output blocks.
  toggleToolOutput(): boolean;
  // A posture change (the policy's own predicate) reaches the
  // indicator on the very next frame.
  setApprovalsSkipped(skipped: boolean): void;
  // The inspectable pair.
  // The streamed draft of the in-flight assistant message; the
  // committed entry replaces it (undefined clears it).
  setStream(text: string | undefined): void;
  setJournalChanges(rows: ReadonlyArray<JournalChangeLike>): void;
  setJournalFilter(filter: JournalFilterLike): void;
  setDiffToolCall(toolCallId: string | null): void;
  panelMode(): PanelMode;
  // Seed the editor's Up history (prompts oldest first).
  seedPromptHistory(prompts: readonly string[]): void;
  openPanel(mode: PanelMode): void;
  // The panel's own scroll surface. The panel row is a
  // ScrollView (the wheel and alt+up / alt+down move it), and these expose
  // the same API to the composition root and to tests.
  panelScrollBy(lines: number): void;
  panelScrollTo(line: number): void;
  panelScrollTop(): number;
  // Cycle the diff panel's files (wrapping); false when there is nothing to
  // cycle (panel closed, journal panel, no rows).
  panelJumpFile(delta: number): boolean;
  // The approval surface. The composition root hands the app the
  // live alt-screen's overlay seat at boot (before that, or on a terminal with
  // no overlay seat, the inline body is the surface).
  attachApprovalOverlay(host: ApprovalOverlayTui): void;
  requestApproval(request: TuiApprovalRequest): Promise<ApprovalDecision>;
  hasPendingApproval(): boolean;
}

// Structural mirror of journal-view's JournalFilter (kept local so the app's
// public surface does not re-export another module's type name for callers
// that only pass a filter through).
export interface JournalFilterLike {
  readonly path?: string;
}
