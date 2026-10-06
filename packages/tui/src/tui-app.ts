// Interactive TUI controller over the solo lane (issue #75; §16).
// Presentation only: the controller replicates the core
// KubicPresentationState (§66 — contracts only, no authority) into the
// tested views (tree #24, transcript #23, status #27) arranged by the
// layout root (#22). The composition root (apps/kubic) owns the lane
// boot, the alt-screen lifecycle, and shutdown.
//
// Issue #88 turns the viewer shell into a prompt loop:
// - the editor slot is a real PromptEditor (Enter submits, Ctrl-J /
//   Shift+Enter / backslash-Enter add a line);
// - `applyLaneEntries` feeds committed lane entries into the transcript as
//   coarse cells (§15.2 — Pi keeps token deltas, Kubic renders the
//   committed entries);
// - `setUsage` carries the lane's usage rows into the status bar;
// - `handleInput` classifies the global keys and leaves every other key to
//   the draft, reporting `cancel` separately from `quit` so the root can
//   abort an in-flight turn before it exits.
//
// Issue #96 adds the §17 always-inspectable pair as a panel row between the
// transcript and the status bar: `Ctrl-O` opens the current run's diff (the
// selected tool call's effects) and `Ctrl-R` opens the session journal; the
// same key closes its panel again. Journal rows arrive through
// `setJournalChanges` — sanitized at ingress by view-panel.ts — so the
// content of a tool's files never reaches a render function raw.
//
// Key map (the shipped loop; docs/cli/commands.md mirrors it):
//   Enter            submit the draft
//   Ctrl-J, Shift+Enter, `\`+Enter   newline (multi-line entry)
//   Ctrl-T           show / hide the tree (solo starts with it hidden;
//                    the orchestrator collapses it to one line)
//   Ctrl-G           switch the session mode (solo ↔ orchestrator;
//                    refused while a turn runs)
//   Ctrl-O           toggle the diff panel (this run's changes)
//   Ctrl-R           toggle the journal panel (the whole session)
//   Ctrl-X           expand / collapse every tool output block
//   Ctrl-C           interrupt the in-flight turn; idle: clear the draft,
//                    then press twice within 2 s to quit (issue #454)
//   Alt+Enter        steer the running turn with the draft (submits it when
//                    idle; issue #334)
//   Esc              close the dropdown or overlay, else interrupt the
//                    running turn — never quits (issue #454)
//   Ctrl-D           quit on an empty draft (delete-forward while typing)
//
// Issue #453 (EPIC N; docs/ui 01-A/L/M) cut the chrome to three one-row
// surfaces: the header (project, branch, session, mode, posture, clock), the
// status line (model, context, cost, journal, state word) and the
// context-aware key-hint row. Command replies, turn outcomes and the working
// line sit on a transient notice row above the editor.

import type {
  KubicPresentationState,
  LaneImagePart,
} from '../../core/src/presentation.js';
import { spinnerFrame } from '../../core/src/ui/glyphs.js';
import {
  type ApprovalCardOptions,
  renderApprovalCard,
} from './approval-card.js';
import {
  type ApprovalSurface,
  createApprovalSurface,
} from './approval-surface.js';
import type {
  ApprovalDecision,
  ApprovalOverlayHandle,
  ApprovalOverlayOptions,
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from './approval-view.js';
import { approvalOverlayOptions } from './approval-view.js';
import { BlockViewer } from './block-viewer.js';
import {
  type HintContext,
  keyCap,
  keyHintSet,
  renderHeader,
  sessionTitle,
  shortSessionId,
} from './chrome.js';
import { renderWorkerPreview, WorkerPreview } from './dashboard/preview.js';
import {
  renderDashboardBody,
  renderDashboardFooter,
  renderDashboardHeader,
  renderDispatchBox,
  renderWorkerDiff,
  workerInspectorLines,
  workerViewLines,
} from './dashboard/render.js';
import { type DashboardModel, resolveSelection } from './dashboard/state.js';
import { type DashboardIntent, DashboardView } from './dashboard/view.js';
import {
  EDITOR_FRAME_CELLS,
  frameEditorLines,
  renderWorkingLine,
  type WorkingInfo,
} from './editor-frame.js';
import { PromptEditor } from './editor-view.js';
import {
  CombinedAutocomplete,
  FileMentionAutocomplete,
  mentionFor,
} from './file-mentions.js';
import {
  DEFAULT_KEY_REGISTRY,
  KEY_ACTIONS,
  type KeyAction,
  type KeyRegistry,
} from './keybindings.js';
import {
  entriesToCells,
  type LaneEntryLike,
  PROMPT_PREFIX,
  sanitizeLaneText,
} from './lane-cells.js';
import { buildLayoutRoot, type Viewport } from './layout.js';
import { PaletteView } from './palette-view.js';
import { PickerView } from './picker-view.js';
import { type PreflightInfo, renderPreflight } from './preflight.js';
import { QuestionView, type WorkerQuestionLike } from './question-view.js';
import {
  findSlashCommand,
  parseSlashCommand,
  SLASH_COMMAND_NAMES,
  SLASH_COMMANDS,
  SlashCommandAutocomplete,
  skillCommandSpecs,
} from './slash-commands.js';
import {
  formatStatusCost,
  StatusBar,
  type StatusBarState,
  type StatusBudgetLimits,
  type StatusMode,
  type StatusTurnState,
  type StatusUsageRow,
  summarizeStatusRows,
} from './status-bar.js';
import { tuiTheme } from './theme.js';
import {
  createTranscriptView,
  type ToolCallState,
  type TranscriptEntry,
  type TranscriptView,
  type TurnReceipt,
} from './transcript.js';
import {
  AgentTreeView,
  applyTreeSnapshot,
  renderAgentInspector,
  type TreeWorker,
} from './tree.js';
import type {
  AutocompleteProvider,
  Component,
  VStack,
} from './tui-boundary.js';
import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  parseKey,
  ScrollView,
  truncateToWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';
import { CLIPBOARD_MAX_BYTES, copySize, formatSize } from './ui/clipboard.js';
import { dimFrame } from './ui/dim.js';
import { fileUrl } from './ui/file-links.js';
import { renderKeyHintRow } from './ui/key-hints.js';
import { leftRight } from './ui/line.js';
import {
  formatAge,
  formatContextWindow,
  PALETTE_FILES_MAX,
  PALETTE_GROUP_ROWS,
  type PaletteItem,
  paletteModelMeta,
} from './ui/palette.js';
import type { PickerGroup } from './ui/picker.js';

// The editor footer wraps to at most this many rows.
export const FOOTER_MAX_ROWS = 2;

// Issue #454: an idle, empty Ctrl-C arms the quit for this long; a second
// press inside the window quits.
export const QUIT_ARM_MS = 2000;

// Issue #459: the rows an approval card leaves for the rest of the screen —
// the header, status and hint rows and three rows of transcript.
export const CARD_CHROME_ROWS = 6;

// Issue #454: the queue box's prompt mid-turn (solo lane), and the
// orchestrator lane's no-queue variant.
export const QUEUE_PLACEHOLDER = 'type to queue — sent when this turn ends';
export const RUN_PLACEHOLDER = 'the run is working — wait for it to finish';

// Issue #457: a thinking cell's generation time is measured only for entries
// this app saw arrive live, and only when the gap is plausible (a resumed
// session's old entries would otherwise read as hours of thought).
export const THINKING_MEASURE_MAX_MS = 10 * 60_000;

// Issue #457: lines added and removed across a turn's journal rows — a
// multiset count (exact for the usual in-place edit), nothing when the
// content is unknown on both sides.
export function journalLineCounts(
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

import {
  DiffPanel,
  type JournalChangeLike,
  JournalPanel,
  type PanelMode,
} from './view-panel.js';

export type { JournalChangeLike, LaneEntryLike, PanelMode, Viewport };

// The request the overlay answers: approval-view.ts's own request shape, named
// here so the composition root and the app agree on one type.
export type TuiApprovalRequest = ApprovalViewRequest;

// Issue #453: the header's workspace facts, read by the composition root
// (the TUI package runs no git of its own).
export interface TuiWorkspace {
  /** Basename of the project root. */
  readonly project: string;
  /** Current branch; absent outside a repository. */
  readonly branch?: string;
  /** Changed files in the working tree. */
  readonly dirty?: number;
}

// Issue #462: the facts only the composition root has for the preflight
// (docs/ui 05-B); the app supplies the model, workspace, mode and keys.
export interface TuiPreflightSeed {
  readonly version?: string;
  /** Where a provider's key comes from (`ANTHROPIC_API_KEY`). */
  readonly keySource?: (provider: string) => string | undefined;
  /** The testing model (`faux/echo`): no model is called. */
  readonly testingModel?: string;
  /** The project layer's trust state; absent when the project has none. */
  readonly trust?: 'loaded' | 'untrusted';
  /** The isolation sentence per mode. */
  readonly isolation?: (mode: StatusMode) => string;
}

// Issue #462: one recent session on the first screen.
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
  // Issue #96: the approval surface to collect verdicts with. The composition
  // root creates it BEFORE the lane boots (the boot installs the policy that
  // consults it as the seat) and passes the same object here, so the surface
  // the operator sees IS the surface the lane asks. Absent means a private
  // one — the viewer shell (`kubic tui` with an injected boot) still renders
  // an ask inline instead of hanging.
  readonly approvalSurface?: ApprovalSurface;
  // Issue #307 (§17, §18): the always-visible mode indicator. Both fields
  // are REQUIRED — seeded from the posture the composition root actually
  // installed — so no call site can silently default a full-access session
  // to 'approvals:on'.
  readonly mode: StatusMode;
  readonly approvalsSkipped: boolean;
  // Issue #347 (§18): the boot model's context window and the token level at
  // which the solo lane compacts. Absent when the catalog does not know the
  // window — the context gauge then stays off.
  readonly contextWindow?: number;
  readonly compactionThreshold?: number;
  // Issue #285 (§71): the opt-in solo budget limits the boot started
  // with. Static for the boot — the burn-down arrives via setBudgetSpend —
  // so the limits (never the spend) are on the bar from the first frame.
  // Absent means the run is unbounded and the bar stays silent.
  readonly budgetLimits?: StatusBudgetLimits;
  // Issue #303 (§16.6/§16.9): the keybinding registry — defaults plus the
  // user's ~/.kubic/keybindings.json overrides, resolved by the composition
  // root. Every key the app claims ahead of the editor is looked up here.
  readonly keys?: KeyRegistry;
  // Issue #336: the workspace files `@` mentions complete from — the
  // composition root's gitignore-aware walk. Absent: slash commands only.
  readonly listFiles?: () => readonly string[];
  // Issue #183 (§29.4): the booted (gated-visible, hidden included) skill
  // names — the composition root threads them so `/skill:<prefix>`
  // completes to `/skill:<name>`. Absent means no per-skill rows.
  readonly skillNames?: readonly string[];
  // Issue #276: told of every real session-mode change (Ctrl-G, /tree…), so
  // the composition root persists it with the session.
  readonly onModeChange?: (mode: StatusMode) => void;
  // Issue #453: the header's project / branch / dirty count (setWorkspace
  // refreshes it after a settled turn).
  readonly workspace?: TuiWorkspace;
  // Issue #453: the header clock (`HH:MM`); absent leaves it off.
  readonly clock?: () => string;
  // Issue #453: the honest lane notice for a mode, shown in the welcome
  // block ('' when suppressed). The composition root owns the text.
  readonly laneNotice?: (mode: StatusMode) => string;
  // Issue #462: what the first screen's preflight needs from the boot.
  readonly preflight?: TuiPreflightSeed;
  // Issue #463: copy text to the system clipboard (OSC 52, written by the
  // composition root). False when this terminal does not take it.
  readonly clipboard?: (text: string) => boolean;
  // Issue #465: the change a worker has made in its worktree (`^O` on the
  // orchestrator dashboard), as unified diff text; undefined when it cannot
  // be read.
  readonly workerDiff?: (worker: {
    readonly workerId: string;
    readonly workspace: string;
  }) => Promise<string | undefined>;
  // Issue #466: the roles the dashboard's `^N` offers a new worker (`tab`
  // cycles them), the first being the default.
  readonly dispatchRoles?: readonly string[];
  // Issue #458: the project's absolute root; with `listFiles`, file
  // references in answers link to `file://<root>/<path>`.
  readonly fileRoot?: string;
  // Issue #459: the workspace as the approval card shows it (`~/proj`).
  readonly cwdLabel?: string;
}

// §66 replication: the TUI holds no authority — it reads the replicated
// snapshot only. The model id is runtime (not presentation state), so it
// arrives alongside.
export function seedFromPresentation(
  state: KubicPresentationState,
  model: string,
  posture: { readonly mode: StatusMode; readonly approvalsSkipped: boolean },
): TuiAppSeed {
  return {
    sessionId: state.session.sessionId,
    model,
    mode: posture.mode,
    approvalsSkipped: posture.approvalsSkipped,
  };
}

export interface TuiInputResult {
  readonly quit: boolean;
  readonly consumed: boolean;
  // Issue #88: Ctrl-C during a turn aborts the operation instead of
  // exiting. The root owns the busy/idle decision; the app only
  // classifies the key, so the count and the exit stay in one place.
  readonly cancel: boolean;
  // Issue #334: Alt+Enter handed the app a non-empty draft as a steer. The
  // app has already cleared the editor; the loop decides what the text
  // becomes (steer the running turn, or submit it when idle), because only
  // the loop knows a lane and its busy state.
  readonly steer?: string;
  // Issue #328: Alt+M opens the model picker (the loop supplies the rows).
  readonly pickModel?: boolean;
  // Issue #328: Alt+T cycles the thinking level over what the live model
  // supports (the loop owns the ladder and the commit).
  readonly cycleThinking?: boolean;
  // Issue #305: Ctrl-P opens the command palette (the loop supplies the
  // registry rows and dispatches the chosen command).
  readonly palette?: boolean;
  // Issue #309: Alt+A toggles full access for this session (the loop owns
  // the confirmation, the posture write and the indicator).
  readonly fullAccess?: boolean;
  // Issue #454: Esc during a turn — interrupt it, and never quit (a second
  // Esc while the interrupt drains is a no-op, unlike Ctrl-C).
  readonly interrupt?: boolean;
}

// Issue #334: what the loop did with a submitted prompt. `queued` means the
// follow-up went into the conversation's inbox (pi-durable `whenBusy:
// 'followUp'`) — the app must NOT echo it as a pending turn; the queued row
// does that. `refused` means no lane could take it at all (an orchestrator
// run is busy, or the session has no lane); the loop has put the reason on
// the footer. Issue #338 adds `command`: the draft was a TUI command
// (`/image`), which ran — nothing is echoed and nothing is restored.
export type TuiSubmitOutcome = 'accepted' | 'queued' | 'refused' | 'command';

// The global keys are classified by pi-tui's own `parseKey`, never by
// comparing raw bytes (issue #88, reviewer finding): a Kitty-class terminal
// negotiates the keyboard protocol and sends CSI-u sequences — Esc arrives
// as '\x1b[27u', Ctrl-D as '\x1b[100;5u', Ctrl-C as '\x1b[27;5;99~' — so a
// `data === '\x1b'` test silently misses them and the key becomes a no-op
// (consumed, no effect), exactly what "no silent no-op key" forbids. The
// editor already routes through Pi's `matchesKey`; these four keys now use
// the same classification as the rest of the loop. The legacy byte forms
// ('\x03', '\x1b', '\x04', '\x14') still parse to the same ids, so nothing
// is lost for terminals that do not negotiate the protocol.
function keyIdOf(data: string): string | undefined {
  try {
    return parseKey(data);
  } catch {
    // Unparseable input is not one of the global keys; it belongs to the
    // editor (parseKey throws on sequences it does not recognise).
    return undefined;
  }
}

// Issue #465/#466: what the orchestrator dashboard asks the loop to do —
// stop or retry a worker, message one, or dispatch a new one — and the
// loop's answer: the footer's word on it, and whether it went out.
export type TuiWorkerAction =
  | { readonly kind: 'stop' | 'retry'; readonly workerId: string }
  | {
      readonly kind: 'message';
      readonly workerId: string;
      readonly text: string;
    }
  | { readonly kind: 'dispatch'; readonly text: string; readonly role: string };

export interface TuiWorkerActionResult {
  readonly footer: string;
  readonly sent?: boolean;
}

// The keys handleInput claims before the editor live in the keybinding
// registry (issue #303, keybindings.ts): each default there carries the probe
// that shows Pi's editor and alt-screen leave it free.

// Issue #328: one row of the `/model` picker overlay. `label` is the
// `provider/id` the operator sees and the value the loop resolves.
export interface TuiModelPickerRow {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  /** Marked as the live model (the picker highlights it). */
  readonly current?: boolean;
  /** A short note (provider origin). */
  readonly note?: string;
  /** Issue #461: the row's `200k ctx · thinking`. */
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  /** The thinking levels the model supports (the picker's thinking row). */
  readonly thinking?: readonly string[];
}

// Issue #461: a provider's header in the model picker. A provider without
// a key is listed with what to set, its models never offered.
export interface TuiModelPickerProvider {
  readonly id: string;
  readonly usable: boolean;
  /** Where its key comes from (`ANTHROPIC_API_KEY`). */
  readonly keySource?: string;
  /** What to set when it has none (`OPENAI_API_KEY`). */
  readonly keyVar?: string;
}

// Issue #305: the generic picker (the model picker, the command palette and
// the session list all render through it).
export interface TuiPickerRow {
  readonly value: string;
  readonly label: string;
  /** Right-aligned (`2m ago · 4 turns · $0.03`). */
  readonly description?: string;
  /** Start the list on this row (the live model, the current session). */
  readonly current?: boolean;
  /** Shown greyed and never chosen (a legacy session), with why. */
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

// Issue #460: the ^P palette's sources. The app owns the command rows (the
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
  /** Its first prompt (issue #461); the id when absent. */
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

// Issue #460: the palette is 80 cells wide, or 70% of a narrower terminal,
// and takes at most 70% of the rows.
export const PALETTE_WIDTH = 80;
export const PALETTE_WIDTH_PERCENT = 70;
export const PALETTE_HEIGHT_PERCENT = 70;

// Issue #309: the confirmation dialog (the full-access toggle's "are you
// sure?"). The accept key is explicit and deliberate — never a bare
// printable letter — and every other key is swallowed while it shows, so
// text typed ahead in the editor can never accept it.
export interface TuiConfirmOptions {
  readonly title: string;
  readonly body: readonly string[];
  /** The key id that accepts (`'ctrl+s'`); everything else is ignored. */
  readonly confirmKey: string;
  /** Its label for the hint row (`'Ctrl-S'`). */
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

export interface TuiModelPickerOptions {
  readonly rows: readonly TuiModelPickerRow[];
  /** Issue #461: every provider, keyless ones included (headers only). */
  readonly providers?: readonly TuiModelPickerProvider[];
  /** The live thinking level: where the thinking row starts. */
  readonly thinking?: string;
  /** The chosen model and the thinking level chosen with it. */
  readonly onSelect: (row: TuiModelPickerRow, thinking?: string) => void;
  readonly onCancel?: () => void;
}

// Below this the overlay cannot composite (Pi's own visible() gate refuses),
// so the picker stays closed and the loop reports it on the footer.
export const MODEL_PICKER_MIN_WIDTH = 60;

// Issue #462: the `?` overlay's groups, by action prefix.
const KEY_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['editor', ['app.', 'prompt.', 'help.']],
  ['session', ['session.', 'model.', 'approvals.']],
  ['transcript', ['transcript.', 'view.']],
  ['panels', ['panel.']],
  ['approvals', ['approval.']],
];

// Issue #461: the thinking levels in order, for the picker's thinking row
// (a requested level the model lacks is clamped down to one it has).
const THINKING_ORDER = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function clampThinking(
  level: string,
  supported: readonly string[],
): string {
  if (supported.length === 0 || supported.includes(level)) return level;
  const rank = THINKING_ORDER.indexOf(level);
  const below = supported.filter(
    (candidate) => THINKING_ORDER.indexOf(candidate) <= rank,
  );
  return below.at(-1) ?? supported[0] ?? level;
}

export interface TuiApp {
  readonly root: VStack;
  readonly tree: AgentTreeView;
  readonly transcript: TranscriptView;
  readonly status: StatusBar;
  readonly editor: PromptEditor;
  render(width: number): string[];
  handleInput(data: string): TuiInputResult;
  finalDocument(width: number): string[];
  // Issue #333 (§66): the app renders from replicated presentation state —
  // the projector folds the lane events, the app never sees them.
  applyPresentation(state: KubicPresentationState): void;
  // The seed the host-side projector starts from (the app owns the live
  // session facts the state mirrors).
  presentationSeed(): {
    sessionId: string;
    model: string;
    mode: StatusMode;
    approvalsSkipped: boolean;
  };
  applyLaneEntries(entries: ReadonlyArray<LaneEntryLike>): void;
  setUsage(rows: ReadonlyArray<StatusUsageRow>): void;
  // Issue #227: the live model label the header, welcome block and status
  // bar show. Called after a `/model` switch lands; presentation only — the
  // lane switch itself happens through the lane's own setModel.
  setModel(model: string, thinking?: string): void;
  // Issue #347: the context gauge follows a `/model` switch. The limits are
  // the NEW model's window and compaction threshold; a model whose window is
  // unknown clears them, so the gauge disappears rather than showing the old
  // model's percentage.
  setContextLimits(limits: {
    contextWindow?: number;
    compactionThreshold?: number;
  }): void;
  // Issue #285 (§71): the attempt count the boot feeds in — the §71
  // gate's own counter, which a tool-start names even when the gate
  // refuses the call. A no-op without seeded limits: an unbounded run
  // never grows a budget segment.
  setBudgetSpend(toolCalls: number): void;
  // Issue #327: orchestrator report lines (the manager-lane run's own
  // output) rendered as transcript text. Presentation only: the report
  // never drives state, and a solo lane snapshot replaces it.
  appendReport(lines: ReadonlyArray<string>): void;
  onSubmit(handler: (prompt: string) => TuiSubmitOutcome | undefined): void;
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  // Issue #453: the transient notice row above the editor (the name is the
  // pre-#453 one: the row used to sit under the editor). Empty clears it.
  setEditorFooter(text: string): void;
  // Issue #453: the status line's state word. A cancel the loop asked for
  // reads `cancelling…` until the turn settles; a failed turn reads `error`
  // until the next one starts.
  setCancelling(cancelling: boolean): void;
  // Issue #457: the settled turn's start (submission) and failure text feed
  // its receipt; a solo turn ends with one.
  setTurnOutcome(
    outcome: 'completed' | 'cancelled' | 'failed',
    info?: { readonly startedAt?: number; readonly detail?: string },
  ): void;
  // Issue #453: the header's project / branch / dirty count.
  setWorkspace(workspace: TuiWorkspace): void;
  // Issue #334: the echo row for a prompt whose turn has STARTED but whose
  // user entry is not committed yet — a queued follow-up the inbox placed.
  // A later committed prompt cell clears it, exactly like a direct submit.
  setPendingEcho(prompt: string | undefined): void;
  // Issue #305: the editor's autocomplete (the registry's `/` commands).
  setAutocomplete(provider: AutocompleteProvider): void;
  // Issue #328: the model picker (§66 model.select). The loop supplies the
  // catalog rows and handles the choice; the app owns the overlay, the
  // modal input and the cancel. Returns false when this boot has no overlay
  // seat (the loop then reports it on the footer instead of failing silent).
  openModelPicker(options: TuiModelPickerOptions): boolean;
  /** Whether the picker overlay is showing (the loop refuses nested keys). */
  isModelPickerOpen(): boolean;
  // Issue #305: the same overlay for the command palette and the session
  // list; `openModelPicker` is this with the model rows mapped.
  openPicker(options: TuiPickerOptions): boolean;
  // Issue #460: ^P's grouped palette (03-A … C). False when this boot has
  // no overlay seat or the terminal is too narrow (the loop says so).
  openPalette(sources: TuiPaletteSources): boolean;
  isPaletteOpen(): boolean;
  // Issue #462: this project's recent sessions on the first screen.
  setRecentSessions(sessions: readonly TuiRecentSession[]): void;
  // Issue #462: `?` — every key binding, grouped (also reachable here).
  openKeysOverlay(): boolean;
  // Issue #305: a command's own output (the `/help` list, `/session`,
  // `/undo`'s verdict) as transcript text. A later lane snapshot replaces
  // it, exactly like the orchestrator report.
  appendNotice(lines: ReadonlyArray<string>): void;
  // Issue #305: `/session` — id, workspace, model, thinking level, tokens and
  // cost from the rows the status bar already carries (one source of truth).
  // `cwd` comes from the boot (the app never guesses a workspace).
  sessionReport(cwd?: string): string;
  // Issue #305: `/new` and `/resume` — clear every session-scoped surface
  // (transcript, tree, usage, panels, echoes) and take the next session's
  // identity, without recreating the app.
  resetSession(options: {
    readonly sessionId: string;
    readonly model: string;
    readonly thinking?: string;
    readonly usage?: ReadonlyArray<StatusUsageRow>;
  }): void;
  // Issue #309: the confirmation dialog (the full-access toggle). Returns
  // false when this boot has no overlay seat.
  openConfirm(options: TuiConfirmOptions): boolean;
  /** Whether a confirmation is showing (a public accessor for embedders). */
  isConfirmOpen(): boolean;
  // Issue #338 (§16.8): the images the next echoed prompt carries, set by
  // the loop together with the submit it accepted.
  setPendingImages(images: readonly LaneImagePart[]): void;
  // Issue #338 (review, cycle 2): how many attachments are armed but NOT yet
  // submitted — the signal `allowEmptySubmit` reads. `setPendingImages` is
  // the echo's copy and outlives the submit; this one is cleared by the
  // submit itself.
  setPendingAttachments(count: number): void;
  // Issue #334 (review): put a refused draft back in the editor, so a busy
  // orchestrator run (or a `/model` typed mid-turn) never eats the text the
  // operator typed.
  restoreDraft(prompt: string): void;
  // Ms since the in-flight turn started (undefined when idle); the root's
  // spinner timer re-renders while this is defined.
  busyElapsedMs(now?: number): number | undefined;
  // Ctrl-X: expand / collapse tool output blocks.
  toggleToolOutput(): boolean;
  // Issue #307: a posture change (the policy's own predicate) reaches the
  // indicator on the very next frame.
  setApprovalsSkipped(skipped: boolean): void;
  // Issue #327: the session mode state — the footer toggle and the runner's
  // submit routing read and write the same value, and the header/status
  // indicator render it.
  mode(): StatusMode;
  setMode(mode: StatusMode): void;
  // Issue #96: the §17 inspectable pair.
  // Issue #296: the streamed draft of the in-flight assistant message; the
  // committed entry replaces it (undefined clears it).
  setStream(text: string | undefined): void;
  setJournalChanges(rows: ReadonlyArray<JournalChangeLike>): void;
  setJournalFilter(filter: JournalFilterLike): void;
  setDiffToolCall(toolCallId: string | null): void;
  panelMode(): PanelMode;
  // Issue #340: seed the editor's Up history (prompts oldest first).
  seedPromptHistory(prompts: readonly string[]): void;
  // Issue #342 (§16.5 AgentInspector): open the capturing inspector for one
  // worker node; false when there is no such worker or no room for it.
  inspectWorker(workerId: string): boolean;
  // Issue #465/#466: the orchestrator dashboard's stop / retry / message /
  // dispatch, carried out by the loop.
  setWorkerActionHandler(
    handler:
      | ((action: TuiWorkerAction) => TuiWorkerActionResult | undefined)
      | undefined,
  ): void;
  // Issue #465: what orchestrator mode shows (the dashboard, or the manager
  // transcript `tab` toggles to).
  orchestratorView(): 'dashboard' | 'manager';
  // Issue #154 (§14.2): a worker's free-text question as a capturing dialog;
  // resolves with the typed answer, or undefined (declined, withdrawn, or no
  // live screen to show it on). One question shows at a time; later ones wait.
  askQuestion(
    question: WorkerQuestionLike,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  openPanel(mode: PanelMode): void;
  // Issue #301: the panel's own scroll surface. The panel row is a
  // ScrollView (the wheel and alt+up / alt+down move it), and these expose
  // the same API to the composition root and to tests.
  panelScrollBy(lines: number): void;
  panelScrollTo(line: number): void;
  panelScrollTop(): number;
  // Cycle the diff panel's files (wrapping); false when there is nothing to
  // cycle (panel closed, journal panel, no rows).
  panelJumpFile(delta: number): boolean;
  // Issue #96: the approval surface. The composition root hands the app the
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
  readonly agent?: string;
}

// Issue #150 (§20.6, §27.1): the footer line for a lane's transient
// activity, or undefined when there is none. The 1.0 harness reports the
// attempt and the error (no maxAttempts, no notBefore — #398's contract), so
// that is what the line names; a retry outranks a compaction.
export function laneActivityLine(lane: {
  readonly retrying?: { readonly attempt: number; readonly error?: string };
  readonly compacting: boolean;
}): string | undefined {
  if (lane.retrying !== undefined) {
    const error = lane.retrying.error;
    return `⟳ retrying · attempt ${lane.retrying.attempt}${error === undefined || error === '' ? '' : ` — ${error}`}`;
  }
  return lane.compacting ? '⟳ compacting context…' : undefined;
}

// Issue #453: the transient notice row above the editor. It shows, in
// order of precedence: the lane's activity (a retry, a compaction), an
// explicit footer (a turn outcome, a command's reply, an error), the working
// line while a turn runs — else nothing, and the row takes no space.
class NoticeRow implements Component {
  // Issue #454: the working line's facts — the keys that act (which differ
  // by lane: the orchestrator lane queues nothing, #334), this turn's
  // tokens and tool calls.
  private readonly working: () => Omit<WorkingInfo, 'elapsedMs'>;
  private footer = '';
  // Issue #150: the lane's transient activity (a retry backoff, a
  // compaction). It outranks every other notice while it lasts — it is the
  // reason the turn looks idle — and clears the moment the state does.
  private activity = '';
  busySince: number | undefined;

  constructor(working: () => Omit<WorkingInfo, 'elapsedMs'>) {
    this.working = working;
    this.busySince = undefined;
  }

  setFooter(text: string): void {
    this.footer = sanitizeLaneText(text);
  }

  footerText(): string {
    return this.footer;
  }

  setActivity(text: string | undefined): void {
    this.activity = text === undefined ? '' : sanitizeLaneText(text);
  }

  render(width: number): string[] {
    const theme = tuiTheme();
    const w = Math.max(0, width);
    // One cell of indent lines the text up with the editor box below.
    if (this.activity !== '') {
      return [truncateToWidth(` ${theme.warning(this.activity)}`, w, '…')];
    }
    if (this.footer !== '') {
      const styled = this.footer.startsWith('error')
        ? theme.error(this.footer)
        : theme.muted(this.footer);
      // Wrapped, not cut: an error report is the text an operator most
      // needs whole. Capped at two rows.
      const wrapped = wrapTextWithAnsi(styled, Math.max(1, width - 1));
      const shown = wrapped.slice(0, FOOTER_MAX_ROWS);
      if (wrapped.length > FOOTER_MAX_ROWS) {
        const last = shown.length - 1;
        shown[last] = truncateToWidth(`${shown[last] ?? ''} …`, w - 1, '…');
      }
      return shown.map((line) => truncateToWidth(` ${line}`, w, '…'));
    }
    if (this.busySince !== undefined) {
      return [
        renderWorkingLine(
          theme.ui,
          { ...this.working(), elapsedMs: Date.now() - this.busySince },
          width,
        ),
      ];
    }
    return [];
  }

  invalidate(): void {}
}

// A single-line component over a render function.
function lineComponent(render: (width: number) => string): Component {
  return {
    render: (width: number): string[] => [render(width)],
    invalidate: (): void => {},
  };
}

// Issue #342: the presentation state's workers as tree nodes (the state
// carries values, the tree its own node shape).
function treeWorkersOf(
  workers: KubicPresentationState['workers'],
): TreeWorker[] {
  return [...workers.values()].map((worker) => ({
    workerId: worker.workerId,
    status: worker.status ?? 'running',
    ...(worker.role === undefined ? {} : { role: worker.role }),
    ...(worker.generation === undefined
      ? {}
      : { generation: worker.generation }),
    ...(worker.workspace === undefined ? {} : { worktree: worker.workspace }),
    ...(worker.model === undefined ? {} : { model: worker.model }),
    ...(worker.inputTokens === undefined
      ? {}
      : { inputTokens: worker.inputTokens }),
    ...(worker.outputTokens === undefined
      ? {}
      : { outputTokens: worker.outputTokens }),
    ...(worker.costUsd === undefined ? {} : { costUsd: worker.costUsd }),
  }));
}

export function createTuiApp(seed: TuiAppSeed): TuiApp {
  const keys = seed.keys ?? DEFAULT_KEY_REGISTRY;
  // Issue #458: project paths that exist get a `file://` link. The lister
  // is the @-mention one (cached by the composition root); the set is
  // rebuilt only when it hands back a new list.
  const listFiles = seed.listFiles;
  const fileRoot = seed.fileRoot;
  const projectFileUrl =
    listFiles === undefined || fileRoot === undefined
      ? undefined
      : (() => {
          let source: readonly string[] | undefined;
          let known = new Set<string>();
          return (path: string): string | undefined => {
            const files = listFiles();
            if (files !== source) {
              source = files;
              known = new Set(files);
            }
            const clean = path.replace(/^\.\//u, '');
            return known.has(clean) ? fileUrl(fileRoot, clean) : undefined;
          };
        })();
  // Issue #453: solo starts with the tree row hidden (collapsed); Ctrl-T
  // opens it. The orchestrator shows it (collapsed, it is one summary line).
  const tree = new AgentTreeView(undefined, {
    label: seed.label ?? 'solo',
    collapsed: seed.mode === 'solo',
  });
  // The transcript row must stay the ScrollView itself so the layout engine
  // sizes it (follow-end only works when the ScrollView is the row).
  const transcript = createTranscriptView({
    // Issue #455: the cards' duration, running clock and waiting state,
    // and the expand key's real cap.
    toolState: (toolCallId: string) => toolStateOf(toolCallId),
    expandKey: () => keyCap(keys.label('transcript.expand')),
    ...(projectFileUrl === undefined ? {} : { fileUrl: projectFileUrl }),
  });
  // Issue #227: the live model label (seed = the boot's model, replaced by
  // `/model`). The header, welcome block and status bar all read it, so one
  // call keeps the three surfaces from drifting apart.
  let modelLabel = seed.model;
  let thinkingLabel = seed.thinking ?? 'off';
  // Issue #305: `/new` and `/resume` keep the app but change the session it
  // shows, so the id every lane apply, report cell and the welcome block are
  // keyed by is state (declared before the first welcome render).
  let sessionId = seed.sessionId;
  // Issue #327: the session mode is live state, not a boot-time literal:
  // the header and the status bar both read this cell, and Ctrl-G writes it
  // (refused while a turn runs). The seed is only the starting value.
  const sessionMode: { current: StatusMode } = { current: seed.mode };
  // Issue #462: the first screen is the preflight (05-A … E), drawn from
  // live state each frame — the model, the workspace the header reads, the
  // mode, the keys and the recent sessions — and gone after the first
  // prompt (a resumed session with history never shows it). The honest
  // isolation sentence is the composition root's, per mode; `/safety`
  // prints the limits in full.
  let welcomeVisible = true;
  let recentSessions: readonly TuiRecentSession[] = [];
  const preflightInfo = (): PreflightInfo => {
    const mode = sessionMode.current;
    const provider = modelLabel.split('/')[0] ?? modelLabel;
    const keySource = seed.preflight?.keySource?.(provider);
    const known = workspace !== undefined;
    return {
      version: seed.preflight?.version ?? '',
      provider: {
        model: modelLabel,
        ...(modelLabel === seed.preflight?.testingModel
          ? { testing: true }
          : {}),
        ...(keySource === undefined
          ? {}
          : { keySource: sanitizeLaneText(keySource) }),
      },
      ...(seed.cwdLabel === undefined
        ? {}
        : {
            project: {
              path: seed.cwdLabel,
              ...(workspace?.branch === undefined
                ? known
                  ? { git: false }
                  : {}
                : { branch: workspace.branch, git: true }),
              ...(workspace?.dirty === undefined
                ? {}
                : { dirty: workspace.dirty }),
            },
          }),
      ...(seed.preflight?.trust === undefined
        ? {}
        : { trust: seed.preflight.trust }),
      mode,
      isolation:
        seed.preflight?.isolation?.(mode) ?? seed.laneNotice?.(mode) ?? '',
      keys: {
        palette: keyCap(keys.label('app.palette')),
        mode: keyCap(keys.label('session.mode')),
        help: keyCap(keys.label('help.keys')),
      },
      recent: recentSessions,
    };
  };
  const refreshWelcome = (): void => {
    transcript.setWelcome(
      welcomeVisible
        ? (width: number) =>
            renderPreflight(tuiTheme().ui, preflightInfo(), width)
        : [],
    );
  };
  const hideWelcome = (): void => {
    if (!welcomeVisible) return;
    welcomeVisible = false;
    refreshWelcome();
  };
  refreshWelcome();
  const barState: StatusBarState = {
    model: modelLabel,
    thinking: thinkingLabel,
    rows: [],
    mode: sessionMode.current,
    approvalsSkipped: seed.approvalsSkipped,
    sessionId: seed.sessionId,
    ...(seed.contextWindow === undefined
      ? {}
      : { contextWindow: seed.contextWindow }),
    ...(seed.compactionThreshold === undefined
      ? {}
      : { compactionThreshold: seed.compactionThreshold }),
    // Issue #285 (§71): limits on the bar from the first frame; the
    // spend half starts at zero and setBudgetSpend moves it.
    ...(seed.budgetLimits === undefined
      ? {}
      : { budget: { limits: seed.budgetLimits, toolCalls: 0 } }),
  };
  // Issue #453: the state word reads the app's live turn facts per frame.
  const status = new StatusBar(barState, {
    live: () => ({ turn: turnState(), busySince: noticeRow.busySince }),
  });
  // The live model label the header, welcome block and status bar show; one
  // path for the boot, a `/model` switch and a session reset (#305).
  const applyModel = (next: string, thinking?: string): void => {
    modelLabel = sanitizeLaneText(next);
    if (thinking !== undefined) thinkingLabel = thinking;
    status.setState({
      ...status.getState(),
      model: modelLabel,
      thinking: thinkingLabel,
    });
    refreshWelcome();
  };
  const setMode = (next: StatusMode): void => {
    if (next === sessionMode.current) return;
    sessionMode.current = next;
    // Issue #465: back in orchestrator mode, a session that ran something
    // returns to its dashboard.
    if (next === 'orchestrator' && dashboard.hasRun)
      dashboard.view = 'dashboard';
    status.setMode(next);
    // Issue #453: each mode starts from its own tree default (solo hidden,
    // orchestrator shown) and its own welcome notice.
    if (tree.isCollapsed() !== (next === 'solo')) tree.toggle();
    refreshWelcome();
    seed.onModeChange?.(next);
  };
  const editor = new PromptEditor();
  // Issue #305: the editor completes the registry's `/`-commands as they are
  // typed (Pi's editor owns the popup and the completion keys); the submit
  // path still parses and dispatches.
  // Issue #305 + #336: one provider for the editor's single slot — the
  // slash commands, then the @-file mentions when a file source exists.
  // Issue #183: the boot's skill names ride the same command provider as
  // per-skill `/skill:<name>` rows, so `/skill:<prefix>` completes.
  const skillSpecs = skillCommandSpecs(seed.skillNames ?? []);
  const commandProvider = new SlashCommandAutocomplete([
    ...SLASH_COMMANDS,
    ...skillSpecs,
  ]);
  editor.setAutocomplete(
    seed.listFiles === undefined
      ? commandProvider
      : new CombinedAutocomplete([
          commandProvider,
          new FileMentionAutocomplete(seed.listFiles),
        ]),
  );
  // Issue #454: this turn's facts for the working line — the usage rows and
  // tool cells that arrived since the turn started.
  let turnRowsBase = 0;
  let toolCells = 0;
  let turnToolsBase = 0;
  const noticeRow = new NoticeRow(() => {
    const rows = status.getState().rows.slice(turnRowsBase);
    let input = 0;
    let output = 0;
    for (const row of rows) {
      input += row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
      output += row.usage.output;
    }
    return {
      queues: sessionMode.current === 'solo',
      ...(rows.length === 0 ? {} : { input, output }),
      tools: toolCells - turnToolsBase,
      interruptKey: keyCap(keys.label('app.cancel')),
    };
  });
  // Issue #459: the card's state, read from the surface per frame.
  const cardOptions = (
    allowable = approvalSurface.isAllowable(),
  ): ApprovalCardOptions => {
    const queued = approvalSurface.queued();
    return {
      armed: approvalSurface.isArmed(),
      allowable,
      keys: approvalSurface.keys(),
      commandPage: approvalSurface.commandPage(),
      position: 1,
      total: 1 + queued.length,
      ...(queued[0] === undefined ? {} : { next: queued[0] }),
      explain: approvalSurface.explaining(),
      ...(seed.cwdLabel === undefined ? {} : { cwd: seed.cwdLabel }),
      pageKey: keyCap(keys.label('approval.page')),
      explainKey: keyCap(keys.label('approval.explain')),
    };
  };
  // Issue #454: Pi's editor inside the kit's box (editor-frame.ts).
  // Issue #459: an approval takes the slot as a blocking card.
  const editorSlot: Component = {
    render: (width: number): string[] => {
      const request = approvalSurface.pending();
      if (request !== undefined) {
        return renderApprovalCard(tuiTheme().ui, request, width, cardOptions());
      }
      const inner = width - EDITOR_FRAME_CELLS;
      return frameEditorLines(
        tuiTheme().ui,
        editor.render(inner >= 1 ? inner : Math.max(1, width)),
        width,
        {
          busy,
          empty: editor.getText() === '',
          hint: seed.listFiles === undefined ? '/ cmd' : '@ file  / cmd',
          placeholder:
            sessionMode.current === 'solo'
              ? QUEUE_PLACEHOLDER
              : RUN_PLACEHOLDER,
        },
      );
    },
    invalidate: (): void => {
      editor.invalidate();
    },
  };
  // Issue #96 — the panel row. Both panels stay mounted and keep their rows;
  // the layout hides the row entirely while the mode is 'closed', so a
  // keypress never leaves blank space behind.
  const diffPanel = new DiffPanel();
  const journalPanel = new JournalPanel();
  let mode: PanelMode = 'closed';
  // Issue #301: the panel body is a ScrollView over whichever panel is open,
  // so a multi-file or long change is reachable (the wheel and the panel's
  // own keys move it). The row component must BE the ScrollView — the layout
  // engine sizes a scroll node itself, exactly as the transcript row does.
  const panelDocument: Component = {
    render: (width: number): string[] =>
      mode === 'diff' ? diffPanel.lines(width) : journalPanel.lines(width),
    invalidate: (): void => {
      diffPanel.invalidate();
      journalPanel.invalidate();
    },
  };
  const panelScroll = new ScrollView(panelDocument, {
    // No follow: the operator's viewport stays where they left it while the
    // run keeps appending journal rows.
    follow: 'none',
    scrollbar: 'auto',
  });
  // Issue #301: the file the diff panel is showing. `file k/N` lives on each
  // file's own header line, and alt+up / alt+down cycle the files, so the
  // header always names the file the viewport was last moved to.
  let panelFile = 0;
  const panelJumpFile = (delta: number): boolean => {
    if (mode !== 'diff') return false;
    const offsets = diffPanel.fileOffsets();
    if (offsets.length === 0) return false;
    panelFile = (panelFile + delta + offsets.length) % offsets.length;
    panelScroll.scrollTo(offsets[panelFile] ?? 0);
    return true;
  };
  // The panel's page step: one row less than the visible body so the jump
  // never loses the operator's place (the journal panel's alt+up/down).
  const panelPageLines = (): number =>
    Math.max(1, panelScroll.viewportHeight - 1);
  const panelStep = (delta: number): void => {
    if (panelJumpFile(delta)) return;
    panelScroll.scrollBy(delta * panelPageLines());
  };
  // The one place the panel mode is written (the Ctrl-O/Ctrl-R toggles and
  // the `openPanel` API both go through it), so the reset below cannot be
  // skipped on the operator's real open path (#301 review).
  const setPanel = (next: PanelMode): void => {
    mode = next;
    panelFile = 0;
    panelScroll.scrollTo(0);
  };
  // Issue #453: the header's session title — the first committed prompt
  // (fresh or resumed alike), else the short id; cleared with the session.
  let title: string | undefined;
  // Sanitized at ingress like lane text: a directory name is local data, but
  // it is still printed into the operator's terminal.
  const cleanWorkspace = (next: TuiWorkspace | undefined) =>
    next === undefined
      ? undefined
      : {
          project: sanitizeLaneText(next.project),
          ...(next.branch === undefined
            ? {}
            : { branch: sanitizeLaneText(next.branch) }),
          ...(next.dirty === undefined ? {} : { dirty: next.dirty }),
        };
  let workspace = cleanWorkspace(seed.workspace);
  // ── Issue #465: the orchestrator dashboard ────────────────────────────────
  // Its view state (which view orchestrator mode shows, the selection, the
  // filter, an answer in progress), the last presentation state the loop
  // applied, and the loop's stop / retry handler.
  const dashboard = new DashboardView();
  let presentation: KubicPresentationState | undefined;
  let workerActionHandler:
    | ((action: TuiWorkerAction) => TuiWorkerActionResult | undefined)
    | undefined;
  // Issue #466: the roles a new worker can take, and the selected worker's
  // live preview (its cards drawn by a private transcript).
  if (seed.dispatchRoles !== undefined && seed.dispatchRoles.length > 0) {
    dashboard.roles = seed.dispatchRoles;
  }
  const preview = new WorkerPreview();
  const dashboardShown = (): boolean =>
    sessionMode.current === 'orchestrator' && dashboard.view === 'dashboard';
  const dashboardModelNow = (): DashboardModel =>
    dashboard.model(presentation, {
      now: Date.now(),
      ...(workspace?.branch === undefined ? {} : { branch: workspace.branch }),
    });
  // The approval card shows wherever it is not deferred: on the dashboard a
  // worker's ask waits in the AWAITING group until `a` opens it.
  const cardVisible = (): boolean =>
    approvalSurface.isShowing() && (!dashboardShown() || dashboard.answering);
  // The rows the dashboard body may take: the terminal less the rows that
  // stay on screen with it (header, footer, hints, notice, an open card).
  const dashboardRows = (width: number): number => {
    const rows = overlayHost?.terminal?.rows ?? 40;
    const card = cardVisible() ? editorSlot.render(width).length : 0;
    // The header, the footer's rule and budget, the dispatch box (3) and
    // the hint row stay on screen with it.
    return Math.max(4, rows - 7 - noticeRow.render(width).length - card);
  };
  const root = buildLayoutRoot({
    header: lineComponent((width) =>
      dashboardShown()
        ? renderDashboardHeader(
            tuiTheme().ui,
            dashboardModelNow(),
            width,
            spinnerFrame(Date.now()),
          )
        : renderHeader(
            tuiTheme().ui,
            {
              mode: sessionMode.current,
              approvalsSkipped: status.getState().approvalsSkipped,
              ...workspace,
              session: title ?? shortSessionId(sessionId),
              waiting: approvalSurface.isShowing()
                ? 1 + approvalSurface.queued().length
                : 0,
              ...(seed.clock === undefined ? {} : { clock: seed.clock() }),
            },
            width,
          ),
    ),
    tree,
    treeVisible: () =>
      sessionMode.current === 'orchestrator' || !tree.isCollapsed(),
    transcript: transcript.component,
    panel: { component: panelScroll, isOpen: () => mode !== 'closed' },
    notice: noticeRow,
    editor: editorSlot,
    editorVisible: () => !dashboardShown() || cardVisible(),
    status,
    dashboard: {
      body: {
        render: (width: number): string[] => {
          const model = dashboardModelNow();
          const selected = resolveSelection(model, dashboard.selected);
          const ui = tuiTheme().ui;
          return renderDashboardBody(ui, model, {
            ...(selected === undefined ? {} : { selected }),
            width,
            maxRows: dashboardRows(width),
            spinner: spinnerFrame(Date.now()),
            // Issue #466: the selected worker's live preview.
            side: (row, sideWidth, rows) =>
              renderWorkerPreview(ui, row, {
                width: sideWidth,
                maxRows: rows,
                cards: (worker, cardWidth) => preview.cards(worker, cardWidth),
              }),
          });
        },
        invalidate: (): void => {},
      },
      footer: {
        render: (width: number): string[] => {
          const ui = tuiTheme().ui;
          const model = dashboardModelNow();
          const target = resolveSelection(model, dashboard.selected);
          return [
            ...renderDashboardFooter(ui, model, width),
            // Issue #466 (04-F): the dispatch box.
            ...renderDispatchBox(
              ui,
              {
                mode: dashboard.dispatchMode,
                text: dashboard.dispatchText,
                focused: dashboard.dispatchFocused,
                role: dashboard.role,
                ...(target === undefined ? {} : { target }),
              },
              width,
            ),
          ];
        },
        invalidate: (): void => {},
      },
      isShown: dashboardShown,
    },
    hints: lineComponent((width) => {
      const set = keyHintSet(hintContext(), keys, {
        queues: sessionMode.current === 'solo',
        files: seed.listFiles !== undefined,
        // Shift+Enter is a newline only where the terminal reports it.
        newline: isKittyProtocolActive() ? '⇧⏎' : '^J',
        // Issue #465: the manager view names the way back to the dashboard.
        dashboard: sessionMode.current === 'orchestrator' && dashboard.hasRun,
      });
      return renderKeyHintRow(tuiTheme().ui, set.hints, width, set.right);
    }),
  });
  let busy = false;
  // Issue #453: the status line's state word inputs — a cancel the loop
  // asked for, and whether the last settled turn failed.
  let cancelling = false;
  let failed = false;
  let revision = 0;
  // Issue #327: the orchestrator report's own cells. The solo lane's
  // entries own the transcript while that lane drives; applying a lane
  // snapshot clears the report (a report is not a session transcript).
  let reportRevision = 0;
  let reportCells: TranscriptEntry[] = [];
  // Issue #305: a command's own output (`/help`, `/session`, `/undo`) lands
  // as transcript text through its own lane/revision pair, so a later lane
  // snapshot replaces it exactly like the orchestrator report.
  let noticeRevision = 0;
  let noticeCells: TranscriptEntry[] = [];
  let submitHandler:
    | ((prompt: string) => TuiSubmitOutcome | undefined)
    | undefined;
  let pendingPrompt: string | undefined;
  // Issue #338: the images the next echoed prompt carries. The loop sets
  // them on the same keystroke as the submit it accepted, the echo renders
  // them, and clearing the echo clears them.
  let pendingImages: readonly LaneImagePart[] = [];
  // Issue #338 (review): Enter with an attachment and no text IS a submit —
  // the image is the prompt. The editor asks this before dropping a blank
  // draft (attach + Enter was a silent no-op otherwise). The count is the
  // loop's UNSUBMITTED attachments, not the echo images: after a submit the
  // echo still holds them, and a blank Enter there must stay a no-op
  // (issue #338 review, cycle 2).
  let pendingAttachments = 0;
  editor.allowEmptySubmit = (): boolean => pendingAttachments > 0;
  let promptCells = 0;
  let promptCellsAtSubmit = 0;
  // Issue #460: the commands this session ran, most recent first — what
  // the palette offers before anything is typed.
  const recentCommands: string[] = [];
  const noteRecentCommand = (prompt: string): void => {
    const parsed = parseSlashCommand(prompt);
    if (parsed === undefined || !SLASH_COMMAND_NAMES.has(parsed.name)) return;
    const at = recentCommands.indexOf(parsed.name);
    if (at !== -1) recentCommands.splice(at, 1);
    recentCommands.unshift(parsed.name);
    recentCommands.length = Math.min(recentCommands.length, PALETTE_GROUP_ROWS);
  };
  editor.onSubmit = (prompt: string): void => {
    if (submitHandler === undefined) return;
    // Issue #334: the loop decides which submit outcome this is. A queued
    // follow-up must not render as a pending turn (the queued row is its
    // feedback), and a refused prompt must not either — the loop's footer
    // says why. Both still pin the transcript: the operator asked to see
    // the tail.
    const outcome = submitHandler(prompt) ?? 'accepted';
    if (outcome !== 'refused') noteRecentCommand(prompt);
    // Issue #462: the first prompt (not a command) clears the first screen.
    if (outcome === 'accepted' && parseSlashCommand(prompt) === undefined) {
      hideWelcome();
    }
    if (outcome === 'refused') {
      // Issue #334 (review): a refused prompt never eats the draft. Pi's
      // editor clears the draft BEFORE onSubmit fires, so the text has to go
      // back — the footer says why it was refused, and the operator can fix
      // the draft instead of retyping it.
      restoreDraft(prompt);
      return;
    }
    if (outcome === 'accepted') echoPendingPrompt(prompt);
    // Issue #465: an objective handed to the manager starts a run, and the
    // dashboard shows it.
    if (
      outcome === 'accepted' &&
      sessionMode.current === 'orchestrator' &&
      parseSlashCommand(prompt) === undefined
    ) {
      dashboard.startRun(prompt);
    }
    transcript.rePin();
  };
  // The prompt echo before the lane commits it (issue #88), also reused for
  // a queued follow-up whose turn has started (#334).
  const echoPendingPrompt = (prompt: string): void => {
    pendingPrompt = sanitizeLaneText(prompt);
    promptCellsAtSubmit = promptCells;
    transcript.setPendingPrompt(pendingPrompt, pendingImages);
  };
  // Issue #334 (review): put a draft the loop refused back in the editor.
  const restoreDraft = (prompt: string): void => {
    editor.setText(prompt);
    transcript.rePin();
  };
  const quit = (): TuiInputResult => ({
    quit: true,
    consumed: true,
    cancel: false,
  });
  // ── Issue #96: the approval surface ───────────────────────────────────────
  // The surface collects the verdict; the app shows it as the inline card in
  // the editor's slot (issue #459), at every width.
  const approvalSurface =
    seed.approvalSurface ??
    createApprovalSurface({ keyOverrides: keys.approvalOverrides() });
  // Issue #96: the surface is created by the composition root (it must exist
  // before the lane boots — the boot installs the policy that consults the
  // seat), so the app cannot pass its own onChange at construction. It
  // attaches one here instead: every change re-syncs the overlay and asks the
  // live screen for a frame. Without the render request an ask that arrives
  // from the lane's async turn would stay invisible until the operator
  // happened to press a key.
  const onSurfaceChange = (): void => {
    syncOverlay();
  };
  approvalSurface.onChange = onSurfaceChange;
  // Boot-time key check (§16.9, criterion 1): a conflicting map is refused by
  // name here rather than binding one action to two keys silently.
  // Issue #315: an approval key may not shadow a loop key either.
  approvalSurface.checkKeys([...keys.globalKeys()]);
  let overlayHost: ApprovalOverlayTui | undefined;
  // Issue #328: the model picker overlay (at most one at a time).
  let modelPicker:
    | {
        readonly view: PickerView;
        /** The model picker has its own hint row (03-D). */
        readonly kind: 'model' | 'list';
        readonly handle: ApprovalOverlayHandle;
        readonly onCancel?: (() => void) | undefined;
      }
    | undefined;
  // The palette and the session list reuse the picker seat; `closePicker`
  // is the one teardown (the model picker's name is kept for its callers).
  // Issue #328 review: Pi neither composites nor focuses the overlay below
  // its minimum width, so the picker must not become a modal that swallows
  // keys with nothing on screen. `undefined` terminal (a fake host in the
  // overlay tests) keeps the picker usable.
  const pickerFits = (): boolean => {
    const columns = overlayHost?.terminal?.columns;
    return columns === undefined || columns >= MODEL_PICKER_MIN_WIDTH;
  };
  // Issue #309: the confirmation dialog's body. Presentation only — the app
  // owns the keys, the loop owns what the verdict does.
  const renderConfirm = (
    options: TuiConfirmOptions,
    width: number,
  ): string[] => {
    const theme = tuiTheme();
    const w = Math.max(1, width);
    const lines = [
      theme.accentBold(truncateToWidth(options.title, w, '…')),
      ...options.body.map((line) => truncateToWidth(theme.muted(line), w, '…')),
      '',
      theme.dim(`[${options.confirmLabel}] confirm · [Esc] cancel`),
    ];
    return lines;
  };
  let confirmOverlay:
    | {
        readonly handle: ApprovalOverlayHandle;
        readonly options: TuiConfirmOptions;
      }
    | undefined;
  const closeConfirm = (verdict: 'confirm' | 'cancel'): void => {
    const open = confirmOverlay;
    confirmOverlay = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (verdict === 'confirm') open.options.onConfirm();
    else open.options.onCancel?.();
  };
  // Issue #461: every "choose one" is a PickerView in the palette's box.
  const pickerMaxRows = (): number =>
    Math.max(
      6,
      Math.floor(
        ((overlayHost?.terminal?.rows ?? 30) * PALETTE_HEIGHT_PERCENT) / 100,
      ),
    );
  const showPicker = (
    view: PickerView,
    kind: 'model' | 'list',
    onCancel: (() => void) | undefined,
  ): boolean => {
    const host = overlayHost;
    if (host === undefined || !pickerFits()) return false;
    closeModelPicker();
    closePalette();
    modelPicker = {
      view,
      kind,
      handle: host.showOverlay(view, paletteOverlayOptions()),
      onCancel,
    };
    host.requestRender?.();
    return true;
  };
  const openPickerOverlay = (options: TuiPickerOptions): boolean => {
    if (overlayHost === undefined || !pickerFits()) return false;
    const view = new PickerView({
      title: options.title ?? 'Choose',
      groups: [
        {
          id: 'rows',
          rows: options.rows.map((row) => ({
            value: row.value,
            text: sanitizeLaneText(row.label),
            ...(row.description === undefined
              ? {}
              : { right: sanitizeLaneText(row.description) }),
            ...(row.current === true ? { current: true } : {}),
            ...(row.disabled === true ? { disabled: true } : {}),
            ...(row.note === undefined ? {} : { note: row.note }),
          })),
        },
      ],
      maxRows: pickerMaxRows,
      onSelect: (row) => {
        closeModelPicker();
        options.onSelect(row.value);
      },
      onClose: () => closeModelPicker(true),
      ...(options.onMove === undefined
        ? {}
        : { onMove: (row) => options.onMove?.(row?.value) }),
    });
    return showPicker(view, 'list', options.onCancel);
  };
  // Issue #461: the model picker (03-D, 03-E) — one group per provider
  // with where its key comes from, keyless providers greyed with what to
  // set, large providers folded, and the thinking row: ←→ steps the levels
  // the selected model supports, ⏎ takes model and level together.
  const openModelPickerOverlay = (options: TuiModelPickerOptions): boolean => {
    if (overlayHost === undefined || !pickerFits()) return false;
    const byValue = new Map<string, TuiModelPickerRow>(
      options.rows.map((row) => [`${row.provider}/${row.id}`, row]),
    );
    const providers: TuiModelPickerProvider[] = [...(options.providers ?? [])];
    for (const row of options.rows) {
      if (!providers.some((provider) => provider.id === row.provider)) {
        providers.push({ id: row.provider, usable: true });
      }
    }
    // The live model's provider first, then the usable ones, keyless last.
    const live = options.rows.find((row) => row.current === true)?.provider;
    const rank = (provider: TuiModelPickerProvider): number =>
      provider.id === live ? 0 : provider.usable ? 1 : 2;
    const ordered = providers
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
      .map((entry) => entry.provider);
    const right = (row: TuiModelPickerRow): string | undefined => {
      const parts = [
        row.contextWindow === undefined
          ? undefined
          : `${formatContextWindow(row.contextWindow)} ctx`,
        row.reasoning === true ? 'thinking' : undefined,
      ].filter((part): part is string => part !== undefined);
      return parts.length === 0 ? undefined : parts.join(' · ');
    };
    // Where a provider came from (built-in, models.json …), from its rows.
    const originOf = (provider: string): string | undefined =>
      options.rows.find((row) => row.provider === provider && row.note)?.note;
    const groups: PickerGroup[] = ordered.map((provider) => {
      const keyVar =
        provider.keyVar === undefined
          ? undefined
          : sanitizeLaneText(provider.keyVar);
      return {
        id: provider.id,
        title: sanitizeLaneText(provider.id).replaceAll('-', ' '),
        status: provider.usable
          ? {
              text:
                provider.keySource !== undefined
                  ? `● key from ${sanitizeLaneText(provider.keySource)}`
                  : `● ${sanitizeLaneText(originOf(provider.id) ?? 'ready')}`,
              ok: true,
            }
          : { text: '○ no key', ok: false },
        ...(provider.usable || keyVar === undefined
          ? {}
          : { right: `set ${keyVar}` }),
        unit: 'models',
        ...(provider.usable ? {} : { disabled: true }),
        rows: options.rows
          .filter((row) => row.provider === provider.id)
          .map((row) => {
            const detail = right(row);
            return {
              value: `${row.provider}/${row.id}`,
              text: sanitizeLaneText(row.id),
              match: sanitizeLaneText(`${row.provider}/${row.id}`),
              ...(row.current === true ? { current: true } : {}),
              ...(detail === undefined ? {} : { right: detail }),
            };
          }),
      };
    });
    const liveThinking = options.thinking ?? 'off';
    let chosen = liveThinking;
    const levelsOf = (value: string | undefined): readonly string[] => {
      const row = value === undefined ? undefined : byValue.get(value);
      return row?.thinking ?? ['off'];
    };
    const view: PickerView = new PickerView({
      title: 'Model',
      groups,
      maxRows: pickerMaxRows,
      onSelect: (row) => {
        const picked = byValue.get(row.value);
        closeModelPicker();
        if (picked === undefined) return;
        options.onSelect(picked, clampThinking(chosen, levelsOf(row.value)));
      },
      onClose: () => closeModelPicker(true),
      onSide: (direction, row) => {
        const levels = levelsOf(row?.value);
        const at = levels.indexOf(clampThinking(chosen, levels));
        const next =
          levels[Math.min(levels.length - 1, Math.max(0, at + direction))];
        if (next !== undefined) chosen = next;
      },
      footer: (ui, row, width) => {
        const levels = levelsOf(row?.value);
        const shown = clampThinking(chosen, levels);
        const cells = levels.map((level) =>
          level === shown
            ? ui.style({ fg: 'fg0', bg: 'bg3' })(` ${level} `)
            : level === liveThinking
              ? ui.style({ fg: 'accent', bold: true })(level)
              : ui.fg('fg3')(level),
        );
        return [
          leftRight(
            `${ui.fg('fg2')(' thinking  ')}${cells.join('  ')}`,
            `${ui.fg('fg1')('←→')}${ui.fg('fg2')(' change ')}`,
            width,
          ),
        ];
      },
    });
    return showPicker(view, 'model', options.onCancel);
  };
  // Issue #462: `?` — every binding of the registry, grouped, with the key
  // it has now (a rebound key shows its own; an unbound one says so), and
  // the alt-screen's own transcript keys.
  const openKeysOverlay = (): boolean => {
    const groups: PickerGroup[] = KEY_GROUPS.map(([id, prefixes]) => ({
      id,
      title: id,
      rows: [
        ...(id === 'transcript'
          ? [
              {
                value: 'pageup',
                text: 'scroll the transcript a page',
                right: 'PgUp/PgDn',
              },
              {
                value: 'home',
                text: 'top / bottom of the transcript',
                right: 'Home/End',
              },
            ]
          : []),
        ...(Object.keys(KEY_ACTIONS) as KeyAction[])
          .filter((action) =>
            prefixes.some((prefix) => action.startsWith(prefix)),
          )
          .map((action) => {
            const cap = keyCap(keys.label(action));
            return {
              value: action,
              text: KEY_ACTIONS[action].description,
              right: cap === '' ? 'unbound' : cap,
            };
          }),
      ],
    }));
    const view = new PickerView({
      title: 'Keys',
      groups,
      maxRows: pickerMaxRows,
      onSelect: () => closeModelPicker(),
      onClose: () => closeModelPicker(true),
    });
    return showPicker(view, 'list', undefined);
  };
  // Issue #154: the open worker question, and the ones waiting behind it.
  let questionOpen: { readonly view: QuestionView } | undefined;
  const questionQueue: Array<() => void> = [];
  const nextQuestion = (): void => {
    questionQueue.shift()?.();
  };
  const askQuestion = (
    question: WorkerQuestionLike,
    signal?: AbortSignal,
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      const start = (): void => {
        const host = overlayHost;
        if (host === undefined || signal?.aborted === true) {
          resolve(undefined);
          nextQuestion();
          return;
        }
        const view = new QuestionView(question);
        const handle = host.showOverlay(view, approvalOverlayOptions());
        const close = (answer: string | undefined): void => {
          if (questionOpen?.view !== view) return;
          questionOpen = undefined;
          try {
            handle.unfocus({ target: editor });
            handle.hide();
          } catch {
            // A torn-down overlay is already gone.
          }
          resolve(answer);
          host.requestRender?.();
          nextQuestion();
        };
        view.onSettle = close;
        questionOpen = { view };
        signal?.addEventListener('abort', () => close(undefined), {
          once: true,
        });
        host.requestRender?.();
      };
      if (questionOpen === undefined && questionQueue.length === 0) start();
      else questionQueue.push(start);
    });
  const closeModelPicker = (notifyCancel = false): void => {
    const open = modelPicker;
    modelPicker = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (notifyCancel) open.onCancel?.();
  };
  // Issue #460: the ^P palette. The app builds the command and file rows
  // and owns what they do in the editor; models and sessions come from the
  // composition root after the palette is up.
  let palette:
    | {
        readonly view: PaletteView;
        readonly handle: ApprovalOverlayHandle;
        readonly sources: TuiPaletteSources;
      }
    | undefined;
  const closePalette = (notifyCancel = false): void => {
    const open = palette;
    palette = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (notifyCancel) open.sources.onCancel?.();
    overlayHost?.requestRender?.();
  };
  // The registry's commands, the recent ones first (in the order they ran),
  // each with the key the registry has bound now.
  const commandItems = (): PaletteItem[] => {
    const rank = (name: string): number => {
      const at = recentCommands.indexOf(name);
      return at === -1 ? recentCommands.length : at;
    };
    return [...SLASH_COMMANDS]
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((spec) => {
        const key =
          spec.keyAction === undefined
            ? ''
            : keyCap(keys.label(spec.keyAction));
        return {
          group: 'commands' as const,
          value: `/${spec.name}`,
          text: `/${spec.name}`,
          detail: spec.summary,
          ...(key === '' ? {} : { meta: key }),
          ...(recentCommands.includes(spec.name) ? { recent: true } : {}),
        };
      });
  };
  const paletteModels = new Map<string, TuiPaletteModel>();
  const modelItem = (model: TuiPaletteModel): PaletteItem => {
    const value = `${model.provider}/${model.id}`;
    paletteModels.set(value, model);
    return {
      group: 'models',
      value,
      text: sanitizeLaneText(value),
      ...(model.current ? { current: true } : {}),
      meta: paletteModelMeta(model.contextWindow, model.reasoning),
    };
  };
  const sessionItem = (session: TuiPaletteSession): PaletteItem => {
    const created =
      session.createdAt === undefined
        ? Number.NaN
        : Date.parse(session.createdAt);
    const meta = [
      Number.isNaN(created) ? undefined : formatAge(Date.now() - created),
      session.turns === undefined
        ? undefined
        : `${session.turns} turn${session.turns === 1 ? '' : 's'}`,
    ].filter((part): part is string => part !== undefined);
    return {
      group: 'sessions',
      value: session.id,
      text: sanitizeLaneText(session.title ?? session.id),
      ...(meta.length === 0 ? {} : { meta: meta.join(' · ') }),
    };
  };
  const fileItems = (): PaletteItem[] =>
    (seed.listFiles?.() ?? []).slice(0, PALETTE_FILES_MAX).map((path) => ({
      group: 'files',
      value: path,
      text: sanitizeLaneText(path),
      meta: '@ insert',
    }));
  const runPaletteItem = (
    item: PaletteItem,
    sources: TuiPaletteSources,
  ): void => {
    closePalette();
    switch (item.group) {
      case 'commands': {
        const spec = findSlashCommand(item.value.slice(1));
        // A command that needs its argument goes to the editor to finish
        // (`/inspect `); the rest run as if typed.
        if (spec !== undefined && /<[^>]+>/u.test(spec.usage)) {
          const head = (spec.usage.split(' ')[0] ?? item.value).replace(
            /<[^>]+>$/u,
            '',
          );
          const draft = editor.getText();
          editor.setText(
            head.endsWith(':') ? `${head}${draft}` : `${head} ${draft}`,
          );
        } else {
          noteRecentCommand(item.value);
          sources.runCommand(item.value);
        }
        break;
      }
      case 'models': {
        const model = paletteModels.get(item.value);
        if (model !== undefined)
          sources.switchModel?.(model.provider, model.id);
        break;
      }
      case 'sessions':
        sources.resumeSession?.(item.value);
        break;
      case 'files':
        editor.insertText(`${mentionFor(item.value)} `);
        break;
    }
    overlayHost?.requestRender?.();
  };
  // 80 cells, or 70% of a narrower terminal; read per frame, so a resize
  // re-sizes it.
  const paletteOverlayOptions = (): ApprovalOverlayOptions => ({
    get width(): number {
      const columns = overlayHost?.terminal?.columns ?? PALETTE_WIDTH;
      return Math.max(
        1,
        Math.min(
          PALETTE_WIDTH,
          Math.floor((columns * PALETTE_WIDTH_PERCENT) / 100),
        ),
      );
    },
    maxHeight: `${PALETTE_HEIGHT_PERCENT}%`,
    anchor: 'center',
    visible: (termWidth: number): boolean =>
      termWidth >= MODEL_PICKER_MIN_WIDTH,
  });
  const openPaletteOverlay = (sources: TuiPaletteSources): boolean => {
    const host = overlayHost;
    if (host === undefined || !pickerFits()) return false;
    closeModelPicker();
    closePalette();
    let items: PaletteItem[] = commandItems();
    const view = new PaletteView({
      items,
      keyLabel: keyCap(keys.label('app.palette')),
      maxRows: () =>
        Math.max(
          6,
          Math.floor(
            ((host.terminal?.rows ?? 30) * PALETTE_HEIGHT_PERCENT) / 100,
          ),
        ),
      onRun: (item) => runPaletteItem(item, sources),
      onClose: () => closePalette(true),
    });
    palette = {
      view,
      handle: host.showOverlay(view, paletteOverlayOptions()),
      sources,
    };
    // The rows that take a read arrive after the first frame: a slow model
    // catalog, session store or file walk never holds the palette up.
    const add = (more: readonly PaletteItem[]): void => {
      if (palette?.view !== view || more.length === 0) return;
      items = [...items, ...more];
      view.setItems(items);
      host.requestRender?.();
    };
    void sources
      .models?.()
      .then((rows) => add(rows.map(modelItem)))
      .catch(() => {});
    void sources
      .sessions?.()
      .then((rows) => add(rows.map(sessionItem)))
      .catch(() => {});
    const files = setTimeout(() => add(fileItems()), 0);
    files.unref?.();
    host.requestRender?.();
    return true;
  };
  // Issue #463: block mode — Esc on an idle, empty editor walks the
  // transcript by blocks (prompt, answer, thinking, tool card, receipt):
  // `↑↓`/`k j` move, `g`/`G` the ends, `y` copies the block, `Y` its
  // command, `⏎` opens it whole in the viewer, `x` expands just it; `i`,
  // `esc` or any other key returns to typing (a printable key is typed).
  let blockMode: { selected: string } | undefined;
  let blockViewer:
    | { readonly view: BlockViewer; readonly handle: ApprovalOverlayHandle }
    | undefined;
  const selectBlock = (id: string): void => {
    blockMode = { selected: id };
    transcript.select(id);
    transcript.reveal(id);
    overlayHost?.requestRender?.();
  };
  const enterBlockMode = (): boolean => {
    const last = transcript.blocks().at(-1);
    if (last === undefined) return false;
    selectBlock(last.id);
    return true;
  };
  const exitBlockMode = (): void => {
    if (blockMode === undefined) return;
    blockMode = undefined;
    transcript.select(undefined);
    transcript.rePin();
    overlayHost?.requestRender?.();
  };
  const selectedBlock = () =>
    transcript.blocks().find((block) => block.id === blockMode?.selected);
  const copyBlock = (meta: boolean): void => {
    const block = selectedBlock();
    if (block === undefined) return;
    copyText(meta ? block.metaText : block.copyText);
  };
  const copyText = (text: string): void => {
    const size = copySize(text);
    if (size > CLIPBOARD_MAX_BYTES) {
      noticeRow.setFooter('too large to copy — ⏎ view and select');
    } else if (seed.clipboard === undefined || !seed.clipboard(text)) {
      noticeRow.setFooter(
        'copy: this terminal does not take clipboard writes (OSC 52)',
      );
    } else {
      noticeRow.setFooter(`copied ${formatSize(size)}`);
    }
    overlayHost?.requestRender?.();
  };
  const blockTitle = (kind: string, meta: string): string => {
    switch (kind) {
      case 'tool':
        return meta;
      case 'prose':
        return 'answer';
      default:
        return kind;
    }
  };
  const closeBlockViewer = (): void => {
    const open = blockViewer;
    blockViewer = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    overlayHost?.requestRender?.();
  };
  const openBlockViewer = (): boolean => {
    const block = selectedBlock();
    if (block === undefined) return false;
    return openViewer(
      blockTitle(block.kind, block.metaText),
      (width) => transcript.blockLines(block.id, width),
      () => copyBlock(false),
    );
  };
  // One whole text in the framed viewer: a transcript block (#463) or a
  // worker's diff (#465).
  const openViewer = (
    viewTitle: string,
    lines: (width: number) => string[],
    onCopy: () => void,
  ): boolean => {
    const host = overlayHost;
    if (host === undefined) return false;
    closeBlockViewer();
    const view = new BlockViewer({
      title: viewTitle,
      lines,
      maxRows: () =>
        Math.max(6, Math.floor(((host.terminal?.rows ?? 30) * 90) / 100)),
      onCopy,
      onClose: closeBlockViewer,
    });
    blockViewer = {
      view,
      handle: host.showOverlay(view, {
        width: '90%',
        maxHeight: '90%',
        anchor: 'center',
      }),
    };
    host.requestRender?.();
    return true;
  };
  // Issue #459: an approval is a card in the editor slot, not an overlay —
  // a change only needs a frame. Issue #460: a palette open over it would
  // dim the card and hide it from the keys' owner, so it closes.
  const syncOverlay = (): void => {
    if (cardVisible() && palette !== undefined) {
      closePalette(true);
    }
    if (!approvalSurface.isShowing()) dashboard.answering = false;
    noteDeferredAsk();
    overlayHost?.requestRender?.();
  };
  const settleApproval = (): void => {
    // Issue #465: one answer at a time from the dashboard — the next ask
    // waits for its own `a`.
    dashboard.answering = false;
    syncOverlay();
  };
  // Issue #465: an ask that arrives while the dashboard shows waits in its
  // AWAITING group; the footer says so once.
  let deferredAsk: unknown;
  const noteDeferredAsk = (): void => {
    const request = approvalSurface.pending();
    if (request === undefined || !dashboardShown() || dashboard.answering) {
      deferredAsk = undefined;
      return;
    }
    if (request === deferredAsk) return;
    deferredAsk = request;
    const waiting = dashboardModelNow().workers.find(
      (row) => row.group === 'awaiting',
    );
    noticeRow.setFooter(
      `◆ ${waiting === undefined ? 'an approval is' : `${sanitizeLaneText(waiting.worker.workerId)} is`} waiting on you · a answer`,
    );
  };
  // Issue #465: what a dashboard key asked for.
  const runDashboardIntent = (
    intent: DashboardIntent,
    model: DashboardModel,
  ): void => {
    switch (intent.kind) {
      case 'hint':
        noticeRow.setFooter(intent.text);
        break;
      case 'open': {
        // Issue #466: the full worker view — its facts and every recent
        // call as a card.
        const row = model.workers.find(
          (entry) => entry.worker.workerId === intent.workerId,
        );
        if (row !== undefined) {
          openViewer(
            sanitizeLaneText(intent.workerId),
            (width) =>
              workerViewLines(
                row,
                (cardWidth) => preview.cards(row.worker, cardWidth),
                width,
              ).map(sanitizeLaneText),
            () => copyText(workerInspectorLines(row).join('\n')),
          );
        }
        break;
      }
      case 'answer': {
        if (!approvalSurface.isShowing()) {
          noticeRow.setFooter('nothing is waiting on you');
          break;
        }
        dashboard.answering = true;
        // The card's arming window starts when it appears, not when the ask
        // arrived: a key pressed with the `a` cannot answer it.
        approvalSurface.reveal();
        const waiting = model.workers.find((row) => row.group === 'awaiting');
        if (waiting !== undefined) dashboard.selected = waiting.worker.workerId;
        noticeRow.setFooter('');
        break;
      }
      case 'stop':
      case 'retry':
        noticeRow.setFooter(
          workerActionHandler?.({
            kind: intent.kind,
            workerId: intent.workerId,
          })?.footer ?? `${intent.kind}: not available in this session`,
        );
        break;
      // Issue #466: the dispatch box.
      case 'message': {
        const answer = workerActionHandler?.(intent);
        if (answer?.sent === true) dashboard.dispatchSent();
        noticeRow.setFooter(
          answer?.footer ?? 'message: not available in this session',
        );
        break;
      }
      case 'dispatch': {
        if (busy) {
          noticeRow.setFooter(
            'dispatch: a new worker starts once this run settles',
          );
          break;
        }
        const answer = workerActionHandler?.(intent);
        if (answer?.sent === true) {
          dashboard.dispatchSent();
          dashboard.startRun(intent.text);
        }
        noticeRow.setFooter(
          answer?.footer ?? 'dispatch: not available in this session',
        );
        break;
      }
      case 'diff':
        openWorkerDiff(intent.workerId, model);
        break;
      default:
        break;
    }
    overlayHost?.requestRender?.();
  };
  const openWorkerDiff = (workerId: string, model: DashboardModel): void => {
    const workspace = model.workers.find(
      (row) => row.worker.workerId === workerId,
    )?.worker.workspace;
    const read = seed.workerDiff;
    if (workspace === undefined || read === undefined) {
      noticeRow.setFooter(`diff: ${workerId} has no worktree to read`);
      return;
    }
    noticeRow.setFooter(`diff: reading ${workerId}…`);
    void read({ workerId, workspace }).then(
      (text) => {
        if (text === undefined) {
          noticeRow.setFooter(`diff: could not read ${workerId}'s worktree`);
        } else if (text.trim() === '') {
          noticeRow.setFooter(`diff: ${workerId} has no changes`);
        } else {
          noticeRow.setFooter('');
          openViewer(
            `diff ${workerId}`,
            (width) => renderWorkerDiff(tuiTheme().ui, text, width),
            () => copyText(text),
          );
        }
        overlayHost?.requestRender?.();
      },
      () => {
        noticeRow.setFooter(`diff: could not read ${workerId}'s worktree`);
        overlayHost?.requestRender?.();
      },
    );
  };
  // Issue #455: what the presentation state says about each call — when the
  // app first saw it, whether it still runs, and its duration once done.
  // Kept across turns (the lane snapshot folds completed turns away).
  const toolTimes = new Map<
    string,
    {
      readonly seenAt: number;
      readonly toolName: string;
      readonly running: boolean;
      readonly durationMs?: number;
    }
  >();
  // The call an approval holds: the newest running call of the asking tool
  // (solo runs one challenged call at a time).
  const waitingToolCallId = (): string | undefined => {
    const request = approvalSurface.pending();
    if (request === undefined) return undefined;
    let found: string | undefined;
    for (const [id, time] of toolTimes) {
      if (time.running && time.toolName === request.toolName) found = id;
    }
    return found;
  };
  const toolStateOf = (toolCallId: string): ToolCallState | undefined => {
    const time = toolTimes.get(toolCallId);
    if (time === undefined) return undefined;
    return {
      ...(time.durationMs === undefined ? {} : { durationMs: time.durationMs }),
      ...(time.running ? { runningMs: Date.now() - time.seenAt } : {}),
      ...(waitingToolCallId() === toolCallId ? { waiting: true } : {}),
    };
  };
  // Issue #457: thinking times (null: seen in loaded history, unmeasured),
  // the receipts of turns settled in this process, and what they count from.
  const thinkingTimes = new Map<string, number | null>();
  let historyPending = true;
  let receipts: Array<{
    readonly afterPrompts: number;
    readonly cell: TranscriptEntry;
  }> = [];
  let receiptCount = 0;
  let lastLaneCells: TranscriptEntry[] = [];
  let receiptBase = { at: Date.now(), rows: 0 };
  let journalRows: ReadonlyArray<JournalChangeLike> = [];
  // A receipt sits before the first prompt committed after its turn settled
  // — a late entry event can never push it above the turn's own answer.
  const withReceipts = (cells: TranscriptEntry[]): TranscriptEntry[] => {
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
  };
  // Issue #454: the idle double-press quit. The notice row says so for the
  // window and clears itself when it lapses (a render is requested — no key
  // arrives to cause one).
  let quitArmedUntil = 0;
  let quitArmTimer: ReturnType<typeof setTimeout> | undefined;
  let quitArmText = '';
  const disarmQuit = (): void => {
    quitArmedUntil = 0;
    if (quitArmTimer !== undefined) clearTimeout(quitArmTimer);
    quitArmTimer = undefined;
  };
  const quitArmed = (): boolean => Date.now() < quitArmedUntil;
  const armQuit = (key: string): void => {
    disarmQuit();
    quitArmedUntil = Date.now() + QUIT_ARM_MS;
    quitArmText = `press ${key} again to quit`;
    noticeRow.setFooter(quitArmText);
    quitArmTimer = setTimeout(() => {
      quitArmTimer = undefined;
      quitArmedUntil = 0;
      if (noticeRow.footerText() !== quitArmText) return;
      noticeRow.setFooter('');
      overlayHost?.requestRender?.();
    }, QUIT_ARM_MS);
    quitArmTimer.unref?.();
  };
  // Issue #453: what the status line's state word and the key-hint row
  // follow. An approval outranks everything: it is what the turn waits on.
  const turnState = (): StatusTurnState => {
    if (approvalSurface.isShowing()) return 'approval';
    if (busy) return cancelling ? 'cancelling' : 'working';
    return failed ? 'error' : 'ready';
  };
  const hintContext = (): HintContext => {
    if (cardVisible()) return 'approval';
    if (palette !== undefined) return 'palette';
    if (blockViewer !== undefined) return 'overlay';
    if (blockMode !== undefined) return 'blocks';
    if (modelPicker?.kind === 'model') return 'model';
    if (
      modelPicker !== undefined ||
      confirmOverlay !== undefined ||
      questionOpen !== undefined
    ) {
      return 'overlay';
    }
    // Issue #465: the dashboard names its own keys.
    if (dashboardShown()) {
      if (dashboard.dispatchFocused) {
        return dashboard.dispatchMode === 'new' ? 'dispatchNew' : 'dispatch';
      }
      return dashboard.filtering ? 'filter' : 'dashboard';
    }
    return busy ? 'working' : 'idle';
  };
  return {
    root,
    tree,
    transcript,
    status,
    editor,
    render: (width: number): string[] => root.render(width),
    handleInput: (data: string): TuiInputResult => {
      // Classified by pi-tui's parseKey so both encodings are honoured:
      // legacy bytes ('\x03') AND Kitty CSI-u sequences ('\x1b[27;5;99~').
      // Issue #306: a Kitty-class terminal reports key releases (and
      // repeats) as their own events, and this listener runs before pi-tui's
      // focused-path release filter. A release is never an action: dropping
      // it here — before approval decide, the global keys and the editor —
      // keeps toggles from cancelling themselves on key-up and a Ctrl-C
      // cancel or an Esc deny from turning into a quit.
      if (isKeyRelease(data))
        return { quit: false, consumed: true, cancel: false };
      const keyId = keyIdOf(data);
      // Decision (issue #306): a held key's repeats reach the draft (held
      // backspace keeps deleting) but never the approval decision keys or a
      // global key — a held Ctrl-O must not strobe the panel, and a held
      // allow key must not answer the NEXT request too.
      if (isKeyRepeat(data) && (cardVisible() || keys.isGlobalKey(keyId))) {
        // Issue #315: a dropped repeat is still typing — it never reaches
        // decide(), so the surface is told to restart its arming window.
        approvalSurface.noteDroppedKey();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #96: a shown approval owns the decision keys FIRST — above every
      // global binding. Answering with Esc must deny the request, not quit the
      // session; the operator can still quit after the request settles. A key
      // the surface does not claim falls through to the normal loop (so the
      // draft, Ctrl-T, Ctrl-O/R and the rest keep working).
      // Issue #465: an ask the dashboard defers is not on screen, so it
      // takes no keys until `a` opens it.
      if (cardVisible() && approvalSurface.decide(data)) {
        settleApproval();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #315: the approval is a capturing modal. While it shows, every
      // key it did not take — prose typed ahead for the next prompt, and a
      // decision key pressed inside the arming window — is dropped rather
      // than reaching the draft. Only the loop's global keys still act.
      // Issue #316: `v` pages a long command in the dialog (never decides).
      if (
        cardVisible() &&
        keys.actionFor('approval', keyId) === 'approval.page' &&
        approvalSurface.nextCommandPage()
      ) {
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #459: `?` opens (and closes) the card's explanation row.
      if (
        cardVisible() &&
        keys.actionFor('approval', keyId) === 'approval.explain' &&
        approvalSurface.toggleExplain()
      ) {
        return { quit: false, consumed: true, cancel: false };
      }
      if (cardVisible() && !keys.isGlobalKey(keyId)) {
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #301: the open panel's navigation. alt+up / alt+down cycle the
      // diff panel's files (and page the journal panel); neither key is
      // claimed by pi-tui's editor or alt-screen bindings, so the draft keeps
      // its own keys. A closed panel does not claim them at all.
      // Issue #154: an open worker question owns the keys (the approval
      // above outranks it): Enter answers, Esc declines.
      if (questionOpen !== undefined) {
        questionOpen.view.handleInput(data);
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #303: every action below is looked up in the registry, so a
      // rebound key acts and the old key falls through to the editor.
      const action = keys.actionFor('global', keyId);
      // Issue #460: the palette is modal like the picker: Esc/Ctrl-C close
      // it, every other key is its own (a stray global key never acts
      // behind it). A terminal resized below its minimum closes it.
      if (palette !== undefined && !pickerFits()) closePalette(true);
      if (palette !== undefined) {
        if (
          action === 'app.cancel' ||
          action === 'app.exit' ||
          action === 'app.interrupt'
        ) {
          closePalette(true);
        } else {
          palette.view.handleInput(data);
        }
        overlayHost?.requestRender?.();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #463: the block viewer owns the keys while it shows.
      if (blockViewer !== undefined) {
        if (action === 'app.interrupt') closeBlockViewer();
        else blockViewer.view.handleInput(data);
        overlayHost?.requestRender?.();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #463: block mode. Any key it does not take returns to typing
      // and is handled as usual (a printable key lands in the editor).
      if (blockMode !== undefined) {
        const blocks = transcript.blocks();
        const at = blocks.findIndex(
          (block) => block.id === blockMode?.selected,
        );
        const go = (index: number): void => {
          const target =
            blocks[Math.max(0, Math.min(blocks.length - 1, index))];
          if (target !== undefined) selectBlock(target.id);
        };
        const done = { quit: false, consumed: true, cancel: false };
        if (action === 'app.cancel' || data === 'i') {
          exitBlockMode();
          return done;
        }
        if (keyId === 'up' || data === 'k') {
          go(at - 1);
          return done;
        }
        if (keyId === 'down' || data === 'j') {
          go(at + 1);
          return done;
        }
        if (data === 'g' || data === 'G') {
          go(data === 'g' ? 0 : blocks.length - 1);
          return done;
        }
        if (data === 'y' || data === 'Y') {
          copyBlock(data === 'Y');
          return done;
        }
        if (keyId === 'enter') {
          openBlockViewer();
          return done;
        }
        if (data === 'x') {
          const selected = blockMode.selected;
          transcript.toggleBlock(selected);
          overlayHost?.requestRender?.();
          return done;
        }
        exitBlockMode();
      }
      if (
        mode !== 'closed' &&
        (action === 'panel.next' || action === 'panel.previous')
      ) {
        panelStep(action === 'panel.next' ? 1 : -1);
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #309: a shown confirmation owns every key. Only its explicit
      // accept key confirms; Esc/Ctrl-C cancel; anything else — a bare
      // printable letter typed ahead, a global toggle — is swallowed.
      if (confirmOverlay !== undefined) {
        if (keyId === confirmOverlay.options.confirmKey) {
          closeConfirm('confirm');
        } else if (
          action === 'app.cancel' ||
          action === 'app.exit' ||
          action === 'app.interrupt'
        ) {
          closeConfirm('cancel');
        }
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #328: the picker is modal while it shows — arrows move, typing
      // filters, Enter selects, Esc/Ctrl-C cancel (Pi's own list bindings).
      // Global keys other than the cancel pair stay swallowed so a stray
      // Ctrl-T cannot toggle a tree behind the overlay. A terminal resized
      // below the overlay's minimum width closes it instead (review): the
      // modal must never outlive what the operator can see.
      if (modelPicker !== undefined && !pickerFits()) {
        closeModelPicker(true);
      }
      if (modelPicker !== undefined) {
        if (
          action === 'app.cancel' ||
          action === 'app.exit' ||
          action === 'app.interrupt'
        ) {
          closeModelPicker(true);
          return { quit: false, consumed: true, cancel: false };
        }
        modelPicker.view.handleInput(data);
        overlayHost?.requestRender?.();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #465: the orchestrator dashboard owns its keys (the editor is
      // not on screen there); a global key it does not take acts as usual.
      // From the manager view, Tab on an empty editor goes back to it.
      if (dashboardShown() && !cardVisible()) {
        const model = dashboardModelNow();
        const before = `${dashboard.filtering}:${dashboard.filter}`;
        const intent = dashboard.handleKey(
          {
            data,
            ...(keyId === undefined ? {} : { keyId }),
            ...(action === undefined ? {} : { action }),
          },
          model,
        );
        if (intent.kind !== 'pass') {
          runDashboardIntent(intent, model);
          if (`${dashboard.filtering}:${dashboard.filter}` !== before) {
            noticeRow.setFooter(
              dashboard.filtering
                ? `/${dashboard.filter}▏ · ⏎ keep · esc clear`
                : dashboard.filter === ''
                  ? ''
                  : `filter: ${dashboard.filter} · esc clears`,
            );
          }
          return { quit: false, consumed: true, cancel: false };
        }
      } else if (
        sessionMode.current === 'orchestrator' &&
        dashboard.hasRun &&
        keyId === 'tab' &&
        editor.getText() === '' &&
        !editor.isShowingAutocomplete()
      ) {
        dashboard.view = 'dashboard';
        noteDeferredAsk();
        overlayHost?.requestRender?.();
        return { quit: false, consumed: true, cancel: false };
      }
      const consumed: TuiInputResult = {
        quit: false,
        consumed: true,
        cancel: false,
      };
      // A pending approval is denied first by every cancel-class key: nobody
      // is left waiting on a verdict that can no longer arrive (the turn
      // would otherwise hang to the lane's timeout).
      const denyPending = (): void => {
        if (!approvalSurface.isShowing()) return;
        approvalSurface.cancelPending();
        settleApproval();
      };
      // Issue #454: Esc never quits. It closes the editor's dropdown (the
      // overlays above close themselves), interrupts a running turn — the
      // root makes the same cancel as a first Ctrl-C — and does nothing on
      // an idle editor (block mode, #463, lives there).
      if (action === 'app.cancel') {
        denyPending();
        if (editor.isShowingAutocomplete()) {
          editor.handleInput(data);
          return consumed;
        }
        if (busy) {
          return { quit: false, consumed: true, cancel: true, interrupt: true };
        }
        // Issue #463: idle with an empty editor, Esc walks the blocks.
        if (editor.getText() === '') enterBlockMode();
        return consumed;
      }
      // Issue #454: Ctrl-C interrupts a running turn (a second press while
      // it drains quits — the root's rule); idle, it clears a draft, then
      // arms: a second press within QUIT_ARM_MS quits.
      if (action === 'app.interrupt') {
        denyPending();
        if (busy) return { quit: true, consumed: true, cancel: true };
        const key = keyCap(keys.label('app.interrupt'));
        if (editor.getText() !== '') {
          editor.setText('');
          disarmQuit();
          noticeRow.setFooter(`${key}: draft cleared`);
          return consumed;
        }
        if (quitArmed()) {
          disarmQuit();
          return { quit: true, consumed: true, cancel: true };
        }
        armQuit(key);
        return consumed;
      }
      // An operator-bound quit key (app.exit has no default since #454): a
      // composed draft is cleared first (#302), an empty editor quits.
      if (action === 'app.exit') {
        denyPending();
        if (editor.getText() !== '') {
          editor.setText('');
          const key = keyCap(keys.label('app.exit'));
          noticeRow.setFooter(
            `${key}: draft cleared — press ${key} again to quit`,
          );
          return consumed;
        }
        return quit();
      }
      if (action === 'app.eof') {
        // Ctrl-D quits only on an empty draft — the shell convention. While
        // typing it stays Pi's delete-forward, so the key is never a silent
        // no-op in either state.
        if (editor.getText() !== '') {
          editor.handleInput(data);
          return { quit: false, consumed: true, cancel: false };
        }
        return quit();
      }
      if (action === 'view.tree') {
        tree.handleInput('t');
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #327 (§17, §81): Ctrl-G switches the session between solo and
      // orchestrator. A turn owns the lane while it runs, so the key is
      // refused there — with the reason on the footer, never a silent no-op.
      if (action === 'session.mode') {
        if (busy) {
          noticeRow.setFooter('mode: finish the current turn before switching');
          return { quit: false, consumed: true, cancel: false };
        }
        setMode(sessionMode.current === 'solo' ? 'orchestrator' : 'solo');
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #96: Ctrl-O / Ctrl-R toggle the §17 inspectable pair. Both are
      // free of pi-tui's own bindings (probed: editor bindings claim
      // a/b/c/d/e/f/g/j/k/u/w/y, the alt-screen claims the arrows, home/end,
      // page keys and ctrl+shift+*), and both are classified through the same
      // seam as every other global key.
      if (action === 'panel.diff') {
        // Through the setter, not a bare assignment: the panel reset (#301)
        // must run on the operator's real open path.
        setPanel(mode === 'diff' ? 'closed' : 'diff');
        return { quit: false, consumed: true, cancel: false };
      }
      if (action === 'panel.journal') {
        setPanel(mode === 'journal' ? 'closed' : 'journal');
        return { quit: false, consumed: true, cancel: false };
      }
      if (action === 'transcript.expand') {
        transcript.toggleExpanded();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #334: Alt+Enter is the steer key. The draft leaves the editor
      // here (like Enter clears it) and the loop decides: a running turn is
      // steered through the harness' own steer queue, an idle session gets
      // the text as a normal submit. An empty draft is a no-op, never a
      // blank steer.
      if (action === 'prompt.steer') {
        const text = editor.getText().trim();
        if (text === '') return { quit: false, consumed: true, cancel: false };
        editor.setText('');
        return { quit: false, consumed: true, cancel: false, steer: text };
      }
      // Issue #305: Ctrl-P opens the command palette (the registry's rows);
      // the loop owns the list and the dispatch.
      if (action === 'app.palette') {
        return { quit: false, consumed: true, cancel: false, palette: true };
      }
      // Issue #309: Alt+A asks the loop to toggle full access (the loop
      // confirms before enabling and writes the posture).
      if (action === 'approvals.fullAccess') {
        return {
          quit: false,
          consumed: true,
          cancel: false,
          fullAccess: true,
        };
      }
      // Issue #328: Alt+M opens the model picker; Alt+T cycles the thinking
      // level. Both are classified here and acted on by the loop.
      if (action === 'model.pick') {
        return { quit: false, consumed: true, cancel: false, pickModel: true };
      }
      if (action === 'model.thinking') {
        return {
          quit: false,
          consumed: true,
          cancel: false,
          cycleThinking: true,
        };
      }
      // Issue #462: `?` on an idle, empty editor lists every key; anywhere
      // else it is the character.
      if (
        action === 'help.keys' &&
        !busy &&
        editor.getText() === '' &&
        openKeysOverlay()
      ) {
        return { quit: false, consumed: true, cancel: false };
      }
      editor.handleInput(data);
      return { quit: false, consumed: true, cancel: false };
    },
    finalDocument: (width: number): string[] => root.render(width),
    presentationSeed: () => ({
      sessionId: seed.sessionId,
      model: modelLabel,
      mode: sessionMode.current,
      approvalsSkipped: status.getState().approvalsSkipped,
    }),
    applyPresentation: (state: KubicPresentationState): void => {
      presentation = state;
      const lane = state.lanes.get(seed.sessionId);
      noticeRow.setActivity(
        lane === undefined ? undefined : laneActivityLine(lane),
      );
      // Issue #342 (§18): the orchestrator's workers become nodes under the
      // manager root — every apply replaces the list (the state is the truth).
      const workers = treeWorkersOf(state.workers);
      if (lane === undefined && workers.length > 0) {
        applyTreeSnapshot(tree.getState(), {
          status: 'idle',
          tools: [],
          workers,
        });
      }
      if (lane !== undefined) {
        applyTreeSnapshot(tree.getState(), {
          status: lane.status,
          tools: lane.tools,
          workers,
          usage: {
            costTotal: state.usage.costUsd,
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
          },
        });
        transcript.setQueuedPrompts(lane.queued);
        // Issue #455: the cards' facts. A call that left the snapshot while
        // still marked running was cut off with its turn: it runs no more.
        const live = new Set<string>();
        for (const tool of lane.tools) {
          live.add(tool.toolCallId);
          const known = toolTimes.get(tool.toolCallId);
          const durationMs = tool.durationMs ?? known?.durationMs;
          toolTimes.set(tool.toolCallId, {
            seenAt: known?.seenAt ?? Date.now(),
            toolName: tool.toolName,
            running: tool.status === 'running',
            ...(durationMs === undefined ? {} : { durationMs }),
          });
        }
        for (const [id, time] of toolTimes) {
          if (time.running && !live.has(id)) {
            toolTimes.set(id, { ...time, running: false });
          }
        }
        // The diff panel follows the run: the newest call of the lane is
        // what "the current run's changes" means, so the panel's default
        // selection tracks it (an explicit setDiffToolCall still wins).
        const last = lane.tools.at(-1);
        if (last !== undefined) diffPanel.followToolCall(last.toolCallId);
      }
      // Issue #333 (review): the state's session facts are the SEED — the
      // lane the boot selected — and the projector never updates them from
      // events. Writing them back here would silently revert the operator's
      // own Ctrl-G toggle or the posture the installed policy reports (and
      // the mode is read at submit time, so the next prompt would go to the
      // lane the session just left). The app owns both; a consumer that
      // wants the live values reads `mode()` / the status bar.
    },
    applyLaneEntries: (entries: ReadonlyArray<LaneEntryLike>): void => {
      // The revision counter makes every apply a fresh snapshot: the
      // transcript replaces its cells instead of appending duplicates.
      revision += 1;
      const now = Date.now();
      const cells = entriesToCells(entries).map((cell) => {
        if (cell.kind !== 'thinking') return cell;
        let time = thinkingTimes.get(cell.id);
        if (time === undefined) {
          const gap =
            cell.timestamp === undefined ? undefined : now - cell.timestamp;
          time =
            !historyPending &&
            gap !== undefined &&
            gap >= 0 &&
            gap < THINKING_MEASURE_MAX_MS
              ? gap
              : null;
          thinkingTimes.set(cell.id, time);
        }
        return time === null ? cell : { ...cell, durationMs: time };
      });
      historyPending = false;
      lastLaneCells = cells;
      transcript.applyLaneSnapshot(
        { laneId: sessionId },
        withReceipts(cells),
        revision,
      );
      // Issue #327: a solo lane snapshot is the session's own transcript, so
      // the orchestrator report stops being it — and the command notices
      // with it (review fix: a stale notice list must never be re-applied by
      // the next `/help`).
      reportCells = [];
      noticeCells = [];
      // The echoed prompt is dropped once the lane has committed a NEW
      // prompt cell (counted, not matched by text: an identical resubmit
      // must not clear on the previous turn's cell).
      promptCells = cells.filter((cell) => cell.kind === 'prompt').length;
      toolCells = cells.filter((cell) => cell.kind === 'tool').length;
      // Issue #462: a session with history never shows the first screen.
      if (promptCells > 0) hideWelcome();
      if (title === undefined) {
        const first = cells
          .filter((cell) => cell.kind === 'prompt')
          .map((cell) =>
            cell.markdown.startsWith(PROMPT_PREFIX)
              ? cell.markdown.slice(PROMPT_PREFIX.length)
              : cell.markdown,
          )
          .find((text) => text.trim() !== '');
        if (first !== undefined) title = sessionTitle(first);
      }
      if (pendingPrompt !== undefined && promptCells > promptCellsAtSubmit) {
        pendingPrompt = undefined;
        pendingImages = [];
        transcript.setPendingPrompt(undefined);
      }
    },
    setUsage: (rows: ReadonlyArray<StatusUsageRow>): void => {
      status.setRows(rows);
    },
    setStream: (text: string | undefined): void => {
      transcript.setStream(text);
    },
    setModel: (next: string, thinking?: string): void => {
      applyModel(next, thinking);
    },
    setContextLimits: (limits): void => {
      status.setState({
        ...status.getState(),
        contextWindow: limits.contextWindow,
        compactionThreshold: limits.compactionThreshold,
      });
    },
    setBudgetSpend: (toolCalls: number): void => {
      const current = status.getState();
      if (current.budget === undefined) return;
      status.setState({
        ...current,
        budget: { ...current.budget, toolCalls },
      });
    },
    appendReport: (lines: ReadonlyArray<string>): void => {
      const clean = lines
        .map((line) => sanitizeLaneText(line))
        .filter((line) => line !== '');
      if (clean.length === 0) return;
      reportRevision += 1;
      reportCells = [
        ...reportCells,
        {
          id: `${sessionId}:report:${reportRevision}`,
          kind: 'text',
          markdown: clean.join('\n'),
        },
      ];
      transcript.applyLaneSnapshot(
        { laneId: `${sessionId}:orchestrator` },
        reportCells,
        reportRevision,
      );
    },
    onSubmit: (
      handler: (prompt: string) => TuiSubmitOutcome | undefined,
    ): void => {
      submitHandler = handler;
    },
    setBusy: (next: boolean): void => {
      if (next && !busy) {
        receiptBase = { at: Date.now(), rows: status.getState().rows.length };
      }
      busy = next;
      // Issue #453: a settled turn ends any cancel; a new one clears the
      // last turn's error.
      cancelling = false;
      if (next) failed = false;
      if (next) {
        turnRowsBase = status.getState().rows.length;
        turnToolsBase = toolCells;
      }
      disarmQuit();
      // Issue #334: the editor stays ENABLED through a turn. Enter is no
      // longer a silent no-op while the lane works: the loop submits it as
      // a follow-up into the conversation's inbox, and Alt+Enter steers.
      noticeRow.busySince = next ? Date.now() : undefined;
      noticeRow.setFooter('');
      if (!next && pendingPrompt !== undefined) {
        pendingPrompt = undefined;
        pendingImages = [];
        transcript.setPendingPrompt(undefined);
      }
    },
    busyElapsedMs: (now: number = Date.now()): number | undefined =>
      noticeRow.busySince === undefined
        ? undefined
        : Math.max(0, now - noticeRow.busySince),
    toggleToolOutput: (): boolean => transcript.toggleExpanded(),
    setApprovalsSkipped: (skipped: boolean): void => {
      status.setApprovalsSkipped(skipped);
    },
    mode: (): StatusMode => sessionMode.current,
    setMode,
    isBusy: (): boolean => busy,
    setEditorFooter: (text: string): void => {
      noticeRow.setFooter(text);
    },
    setCancelling: (next: boolean): void => {
      cancelling = busy && next;
    },
    setTurnOutcome: (outcome, info = {}): void => {
      failed = outcome === 'failed';
      cancelling = false;
      // Issue #457 (01-J): a solo turn ends with its receipt.
      if (sessionMode.current !== 'solo') return;
      const now = Date.now();
      const start = Math.max(info.startedAt ?? receiptBase.at, receiptBase.at);
      const rows = status.getState().rows;
      const changed = journalRows.filter((row) => row.timestamp >= start);
      const files = new Set(changed.map((row) => row.path)).size;
      const counts = journalLineCounts(changed);
      const detail = info.detail?.split('\n', 1)[0]?.trim();
      const receipt: TurnReceipt = {
        outcome,
        elapsedMs: Math.max(0, now - start),
        tools: [...toolTimes.values()].filter((time) => time.seenAt >= start)
          .length,
        files,
        ...(counts === undefined ? {} : counts),
        costUsd: rows
          .slice(receiptBase.rows)
          .reduce((sum, row) => sum + row.usage.cost.total, 0),
        ...(detail === undefined || detail === ''
          ? {}
          : { detail: sanitizeLaneText(detail) }),
        diffKey: keyCap(keys.label('panel.diff')),
      };
      receiptCount += 1;
      receipts.push({
        afterPrompts: promptCells,
        cell: {
          id: `${sessionId}:receipt:${receiptCount}`,
          kind: 'receipt',
          markdown: '',
          receipt,
        },
      });
      receiptBase = { at: now, rows: rows.length };
      revision += 1;
      transcript.applyLaneSnapshot(
        { laneId: sessionId },
        withReceipts(lastLaneCells),
        revision,
      );
    },
    setWorkspace: (next: TuiWorkspace): void => {
      workspace = cleanWorkspace(next);
    },
    restoreDraft: (prompt: string): void => {
      restoreDraft(prompt);
    },
    openModelPicker: (options: TuiModelPickerOptions): boolean =>
      openModelPickerOverlay(options),
    openPicker: (options: TuiPickerOptions): boolean =>
      openPickerOverlay(options),
    openPalette: (sources: TuiPaletteSources): boolean =>
      openPaletteOverlay(sources),
    isPaletteOpen: (): boolean => palette !== undefined,
    setRecentSessions: (sessions: readonly TuiRecentSession[]): void => {
      recentSessions = sessions.map((session) => ({
        title: sanitizeLaneText(session.title),
        age: sanitizeLaneText(session.age),
        detail: sanitizeLaneText(session.detail),
      }));
      overlayHost?.requestRender?.();
    },
    openKeysOverlay: (): boolean => openKeysOverlay(),
    openConfirm: (options: TuiConfirmOptions): boolean => {
      if (overlayHost === undefined) return false;
      closeConfirm('cancel');
      const view: Component = {
        render: (width: number): string[] => renderConfirm(options, width),
        invalidate: (): void => {},
      };
      confirmOverlay = {
        handle: overlayHost.showOverlay(view, approvalOverlayOptions()),
        options,
      };
      overlayHost.requestRender?.();
      return true;
    },
    isConfirmOpen: (): boolean => confirmOverlay !== undefined,
    isModelPickerOpen: (): boolean => modelPicker !== undefined,
    setAutocomplete: (provider: AutocompleteProvider): void => {
      editor.setAutocomplete(provider);
    },
    appendNotice: (lines: ReadonlyArray<string>): void => {
      const clean = lines
        .map((line) => sanitizeLaneText(line))
        .filter((line) => line !== '');
      if (clean.length === 0) return;
      noticeRevision += 1;
      noticeCells = [
        ...noticeCells,
        {
          id: `${sessionId}:notice:${noticeRevision}`,
          kind: 'text',
          markdown: clean.join('\n'),
        },
      ];
      transcript.applyLaneSnapshot(
        { laneId: `${sessionId}:notice` },
        noticeCells,
        noticeRevision,
      );
      transcript.rePin();
    },
    sessionReport: (cwd?: string): string => {
      const state = status.getState();
      const summary = summarizeStatusRows(state.rows);
      const where = cwd === undefined ? '' : ` in ${cwd}`;
      return `session ${sessionId}${where} · ${state.model} · thinking ${state.thinking} · in ${summary.input} out ${summary.output} (cached ${summary.cacheRead}) · ${formatStatusCost(summary.costTotal)}`;
    },
    resetSession: (options): void => {
      sessionId = options.sessionId;
      revision += 1;
      transcript.applyLaneSnapshot({ laneId: sessionId }, [], revision);
      reportCells = [];
      noticeCells = [];
      pendingPrompt = undefined;
      promptCells = 0;
      promptCellsAtSubmit = 0;
      transcript.setPendingPrompt(undefined);
      transcript.setQueuedPrompts([]);
      tree.reset(undefined, sessionMode.current === 'solo');
      title = undefined;
      toolTimes.clear();
      thinkingTimes.clear();
      historyPending = true;
      receipts = [];
      lastLaneCells = [];
      journalRows = [];
      receiptBase = { at: Date.now(), rows: options.usage?.length ?? 0 };
      toolCells = 0;
      turnToolsBase = 0;
      turnRowsBase = 0;
      failed = false;
      cancelling = false;
      mode = 'closed';
      diffPanel.setChanges([]);
      journalPanel.setChanges([]);
      diffPanel.setToolCall(null);
      editor.setText('');
      noticeRow.setFooter('');
      applyModel(options.model, options.thinking);
      status.setState({
        ...status.getState(),
        sessionId: options.sessionId,
        journalChanges: 0,
      });
      status.setRows([...(options.usage ?? [])]);
      // Issue #463: the old session's blocks are gone.
      closeBlockViewer();
      exitBlockMode();
      // Issue #465: and so is its run.
      dashboard.reset();
      presentation = undefined;
      // Issue #462: a fresh session starts on the first screen again (a
      // resumed one with history hides it when its entries apply).
      welcomeVisible = true;
      refreshWelcome();
    },
    setPendingEcho: (prompt: string | undefined): void => {
      if (prompt === undefined) {
        pendingPrompt = undefined;
        pendingImages = [];
        transcript.setPendingPrompt(undefined);
        return;
      }
      echoPendingPrompt(prompt);
      transcript.rePin();
    },
    // Issue #338: the attachments the next echo carries. The loop sets them
    // as part of the submit it accepted, so the echoed prompt renders the
    // images the lane was actually given.
    setPendingImages: (images: readonly LaneImagePart[]): void => {
      pendingImages = images;
      if (pendingPrompt !== undefined) {
        transcript.setPendingPrompt(pendingPrompt, pendingImages);
      }
    },
    setPendingAttachments: (count: number): void => {
      pendingAttachments = count;
    },
    setJournalChanges: (rows: ReadonlyArray<JournalChangeLike>): void => {
      journalRows = rows;
      diffPanel.setChanges(rows);
      journalPanel.setChanges(rows);
      status.setState({ ...status.getState(), journalChanges: rows.length });
    },
    setJournalFilter: (filter: JournalFilterLike): void => {
      journalPanel.setFilter(filter);
    },
    setDiffToolCall: (toolCallId: string | null): void => {
      diffPanel.setToolCall(toolCallId);
    },
    panelMode: (): PanelMode => mode,
    seedPromptHistory: (prompts: readonly string[]): void => {
      editor.seedHistory(prompts);
    },
    askQuestion,
    inspectWorker: (workerId: string): boolean => {
      const worker = tree
        .getState()
        .workers.find((node) => node.workerId === workerId);
      if (worker === undefined) return false;
      // A read-only capturing list: Enter or Esc closes it.
      return openPickerOverlay({
        rows: renderAgentInspector(worker).map((line, index) => ({
          value: String(index),
          label: line,
        })),
        onSelect: () => {},
      });
    },
    setWorkerActionHandler: (handler): void => {
      workerActionHandler = handler;
    },
    orchestratorView: (): 'dashboard' | 'manager' => dashboard.view,
    openPanel: setPanel,
    panelScrollBy: (lines: number): void => {
      panelScroll.scrollBy(Math.trunc(lines));
    },
    panelScrollTo: (line: number): void => {
      panelScroll.scrollTo(Math.trunc(line));
    },
    panelScrollTop: (): number => panelScroll.scrollTop,
    panelJumpFile: (delta: number): boolean => panelJumpFile(delta),
    attachApprovalOverlay: (host: ApprovalOverlayTui): void => {
      overlayHost = host;
      // Issue #460: while the palette or a picker is open the screen behind
      // it is dimmed (03-A); the key-hint row at the bottom stays lit.
      host.baseFilter = (lines: string[]): string[] =>
        palette !== undefined ||
        modelPicker !== undefined ||
        blockViewer !== undefined
          ? dimFrame(tuiTheme().ui, lines)
          : lines;
      // Issue #96: the live screen's render request, so an ask that arrives
      // from the lane's async turn paints a frame immediately. Optional on
      // the seam (see ApprovalOverlayTui) — a host that lacks it still gets
      // the overlay, just drawn on the next frame the loop already renders.
      approvalSurface.renderRequest = (): void => {
        host.requestRender?.();
      };
      // Issue #316: whether the shown ask fits the live terminal; a host
      // that reports no size keeps the fixed layout.
      // Issue #459: the card, the header, status and hint rows and three
      // rows of transcript must fit the terminal; until they do, only deny
      // acts (the card says so). Measured with the allow keys showing.
      approvalSurface.fitCheck = (): boolean => {
        const request = approvalSurface.pending();
        const terminal = host.terminal;
        if (request === undefined || terminal === undefined) return true;
        const rows = renderApprovalCard(
          tuiTheme().ui,
          request,
          terminal.columns,
          cardOptions(true),
        ).length;
        return rows + CARD_CHROME_ROWS <= terminal.rows;
      };
      // A request that arrived before boot finished is shown now.
      syncOverlay();
    },
    requestApproval: (
      request: TuiApprovalRequest,
    ): Promise<ApprovalDecision> => {
      const pending = approvalSurface.ask(request);
      syncOverlay();
      return pending;
    },
    hasPendingApproval: (): boolean => approvalSurface.isShowing(),
  };
}
