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
//   Ctrl-T           toggle the tree
//   Ctrl-G           switch the session mode (solo ↔ orchestrator;
//                    refused while a turn runs)
//   Ctrl-O           toggle the diff panel (this run's changes)
//   Ctrl-R           toggle the journal panel (the whole session)
//   Ctrl-X           expand / collapse every tool output block
//   Ctrl-C           cancel the in-flight turn; quit when idle (a second
//                    Ctrl-C during a turn also quits)
//   Alt+Enter        steer the running turn with the draft (submits it when
//                    idle; issue #334)
//   Esc              quit
//   Ctrl-D           quit on an empty draft (delete-forward while typing)

import type {
  KubicPresentationState,
  LaneImagePart,
} from '../../core/src/presentation.js';
import {
  type ApprovalSurface,
  createApprovalSurface,
} from './approval-surface.js';
import type {
  ApprovalDecision,
  ApprovalKeyOverrides,
  ApprovalOverlayHandle,
  ApprovalOverlayOptions,
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from './approval-view.js';
import {
  ApprovalView,
  approvalFitsOverlay,
  approvalOverlayOptions,
  approvalOverlayRows,
  approvalOverlayWidth,
  showApprovalOverlay,
} from './approval-view.js';
import { PromptEditor } from './editor-view.js';
import {
  CombinedAutocomplete,
  FileMentionAutocomplete,
} from './file-mentions.js';
import {
  DEFAULT_KEY_REGISTRY,
  type KeyAction,
  type KeyRegistry,
} from './keybindings.js';
import {
  entriesToCells,
  type LaneEntryLike,
  sanitizeLaneText,
} from './lane-cells.js';
import { buildLayoutRoot, type Viewport } from './layout.js';
import { QuestionView, type WorkerQuestionLike } from './question-view.js';
import {
  SLASH_COMMANDS,
  SlashCommandAutocomplete,
  skillCommandSpecs,
} from './slash-commands.js';
import {
  formatStatusCost,
  StatusBar,
  type StatusBarState,
  type StatusMode,
  type StatusUsageRow,
  summarizeStatusRows,
} from './status-bar.js';
import {
  formatElapsed,
  spinnerFrame,
  tuiTheme,
  WORDMARK_GLYPH,
  WORDMARK_NAME,
  WORDMARK_TAGLINE,
} from './theme.js';
import {
  createTranscriptView,
  type TranscriptEntry,
  type TranscriptView,
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
  SelectItem,
  SelectListTheme,
  VStack,
} from './tui-boundary.js';
import {
  isKeyRelease,
  isKeyRepeat,
  parseKey,
  ScrollView,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from './tui-boundary.js';

// The editor footer wraps to at most this many rows.
export const FOOTER_MAX_ROWS = 2;

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
  /** A short note (provider origin), rendered dim under the label. */
  readonly note?: string;
}

// Issue #305: the generic picker (the model picker, the command palette and
// the session list all render through it).
export interface TuiPickerRow {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** Start the list on this row (the live model, the current session). */
  readonly current?: boolean;
}

export interface TuiPickerOptions {
  readonly rows: readonly TuiPickerRow[];
  readonly onSelect: (value: string) => void;
  readonly onCancel?: () => void;
}

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
  readonly onSelect: (row: TuiModelPickerRow) => void;
  readonly onCancel?: () => void;
}

// How many picker rows fit at once; the list scrolls beyond it.
export const MODEL_PICKER_MAX_ROWS = 10;
// The overlay's share of the terminal: wide enough for `provider/id` rows,
// tall enough for MODEL_PICKER_MAX_ROWS plus the list's scroll hint.
export const MODEL_PICKER_WIDTH_PERCENT = 60;
export const MODEL_PICKER_HEIGHT_PERCENT = 60;
// Below this the overlay cannot composite (Pi's own visible() gate refuses),
// so the picker stays closed and the loop reports it on the footer.
export const MODEL_PICKER_MIN_WIDTH = 60;

// The picker's overlay placement: centered, capturing, and hidden on
// terminals too narrow to composite it (the same rule the approval dialog
// uses, with its own minimum).
function modelPickerOverlayOptions(): ApprovalOverlayOptions {
  return {
    width: `${MODEL_PICKER_WIDTH_PERCENT}%`,
    maxHeight: `${MODEL_PICKER_HEIGHT_PERCENT}%`,
    anchor: 'center',
    visible: (termWidth: number): boolean =>
      termWidth >= MODEL_PICKER_MIN_WIDTH,
  };
}

function modelPickerTheme(): SelectListTheme {
  const theme = tuiTheme();
  return {
    selectedPrefix: (text: string): string => theme.accent(text),
    selectedText: (text: string): string => theme.accentBold(text),
    description: (text: string): string => theme.muted(text),
    scrollInfo: (text: string): string => theme.muted(text),
    noMatch: (text: string): string => theme.muted(text),
  };
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
  // Issue #327: orchestrator report lines (the manager-lane run's own
  // output) rendered as transcript text. Presentation only: the report
  // never drives state, and a solo lane snapshot replaces it.
  appendReport(lines: ReadonlyArray<string>): void;
  onSubmit(handler: (prompt: string) => TuiSubmitOutcome | undefined): void;
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  setEditorFooter(text: string): void;
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

// The key hints shown under the editor while idle. The editor's own keys are
// fixed (Pi owns them); every Kubic action reads its key from the registry
// (issue #303), so a rebound action is hinted under its new key and an
// unbound one is not hinted at all.
export function keyHints(
  keys: KeyRegistry = DEFAULT_KEY_REGISTRY,
): ReadonlyArray<readonly [string, string]> {
  const actions: ReadonlyArray<readonly [KeyAction, string]> = [
    ['transcript.expand', 'expand output'],
    ['panel.diff', 'diff'],
    ['panel.journal', 'journal'],
    ['view.tree', 'tree'],
    ['session.mode', 'mode'],
    ['app.exit', 'quit'],
  ];
  return [
    ['enter', 'send'],
    ['ctrl+j', 'newline'],
    ['ctrl+a/ctrl+e', 'line start/end'],
    ...actions
      .map(([action, what]) => [keys.label(action), what] as const)
      .filter(([key]) => key !== ''),
  ];
}

export const KEY_HINTS: ReadonlyArray<readonly [string, string]> = keyHints();

// Issue #302: pi-tui's alt screen claims these keys ahead of the editor, so
// they scroll the transcript — which is also why Home/End no longer reach
// the line ends (Ctrl-A/Ctrl-E do). The welcome block names them: a key the
// operator cannot discover is a key that does not exist (§17).
export const TRANSCRIPT_KEY_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['pgup/pgdn', 'scroll'],
  ['home/end', 'top/bottom'],
  ['ctrl+up/down', 'prev/next prompt'],
  ['ctrl+shift+f', 'search'],
];

export function renderKeyHints(
  width: number,
  hints: ReadonlyArray<readonly [string, string]> = KEY_HINTS,
): string {
  const theme = tuiTheme();
  let line = '';
  let plain = 0;
  for (const [key, action] of hints) {
    const sep = line === '' ? '' : theme.muted(' · ');
    const piece = `${sep}${theme.bold(key)} ${theme.muted(action)}`;
    const pieceWidth = (line === '' ? 0 : 3) + key.length + 1 + action.length;
    if (plain + pieceWidth > width) break;
    line += piece;
    plain += pieceWidth;
  }
  return line;
}

// The working indicator: spinner, elapsed time and the cancel key.
// One line under the editor while a turn runs: the elapsed clock plus the
// keys that still act. Enter and Alt+Enter are named for the SOLO lane
// because they are the two ways to keep talking to a busy turn (#334); the
// orchestrator lane has no inbox and refuses both, so its working line keeps
// the Ctrl-C hint alone. Ctrl-C keeps its shipped meaning throughout (first
// cancels, second quits).
export function renderWorkingLine(
  elapsedMs: number,
  width: number,
  options: { queues?: boolean } = {},
): string {
  const theme = tuiTheme();
  const tail =
    options.queues === false
      ? `${formatElapsed(elapsedMs)} · ctrl+c cancels`
      : `${formatElapsed(elapsedMs)} · enter queues · alt+enter steers · ctrl+c cancels`;
  const line = `${theme.warm(spinnerFrame(elapsedMs))} ${theme.warm('working…')} ${theme.muted(tail)}`;
  return truncateToWidth(line, Math.max(0, width), '…');
}

// The one-line brand header: the Konic mark and wordmark on the left, the
// mode and model on the right.
export function renderHeader(
  width: number,
  info: { mode: string; model: string; cwd?: string },
): string {
  const theme = tuiTheme();
  const left = `${theme.accentBold(`${WORDMARK_GLYPH} ${WORDMARK_NAME}`)} ${theme.muted(WORDMARK_TAGLINE)}`;
  const leftWidth = visibleWidth(
    `${WORDMARK_GLYPH} ${WORDMARK_NAME} ${WORDMARK_TAGLINE}`,
  );
  const rightPlain = `${info.mode} · ${info.model}`;
  const right = `${theme.accent(info.mode)} ${theme.muted('·')} ${info.model}`;
  const room = width - leftWidth - 2;
  if (room >= visibleWidth(rightPlain)) {
    return `${left}${' '.repeat(width - leftWidth - visibleWidth(rightPlain))}${right}`;
  }
  return truncateToWidth(left, Math.max(0, width), '…');
}

// The welcome block at the top of the transcript: what this is, where it
// runs, and the solo notice in full.
export function welcomeLines(info: {
  sessionId: string;
  model: string;
  notice?: string;
  hints?: ReadonlyArray<readonly [string, string]>;
}): string[] {
  const hints = info.hints ?? KEY_HINTS;
  const theme = tuiTheme();
  const lines = [
    '',
    `${theme.accentBold(WORDMARK_GLYPH)} ${theme.bold('Kubic')} ${theme.muted('— terminal coding agent by Konic')}`,
    `  ${theme.muted(`model ${info.model}`)}`,
  ];
  if (info.notice !== undefined && info.notice !== '') {
    lines.push(`  ${theme.warning('!')} ${theme.muted(info.notice)}`);
  }
  lines.push('', `  ${theme.muted('Type a task and press enter.')}`);
  // Three hints per row keeps every row inside a narrow terminal: the hint
  // rows are rendered at their natural width (the welcome block is not
  // re-wrapped), so a long row would be cut rather than continued.
  for (let i = 0; i < hints.length; i += 3) {
    lines.push(
      `  ${renderKeyHints(Number.POSITIVE_INFINITY, hints.slice(i, i + 3))}`,
    );
  }
  lines.push(
    `  ${theme.muted('transcript:')} ${renderKeyHints(Number.POSITIVE_INFINITY, TRANSCRIPT_KEY_HINTS)}`,
  );
  return lines;
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

// The layout's fourth row is one component (issue #22 owns arrangement
// only), so the editor and its one-line hint slot are composed here rather
// than widening the layout. The slot shows, in order of precedence: an
// explicit footer (outcome / error / cancelling), the working indicator
// while a turn runs, else the key hints.
class EditorRow implements Component {
  private readonly editor: PromptEditor;
  // Issue #334: the busy line names the keys that act on a running turn,
  // which differ by lane (the orchestrator lane queues nothing).
  private readonly mode: () => StatusMode;
  private footer: string;
  private readonly hints: ReadonlyArray<readonly [string, string]>;
  busySince: number | undefined;

  constructor(
    editor: PromptEditor,
    mode: () => StatusMode,
    hints: ReadonlyArray<readonly [string, string]> = KEY_HINTS,
  ) {
    this.editor = editor;
    this.mode = mode;
    this.hints = hints;
    this.footer = '';
    this.busySince = undefined;
  }

  setFooter(text: string): void {
    this.footer = sanitizeLaneText(text);
  }

  // Issue #150: the lane's transient activity (a retry backoff, a
  // compaction). It outranks every other footer line while it lasts — it is
  // the reason the turn looks idle — and clears the moment the state does.
  private activity = '';

  setActivity(text: string | undefined): void {
    this.activity = text === undefined ? '' : sanitizeLaneText(text);
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    const theme = tuiTheme();
    if (this.activity !== '') {
      return [
        ...lines,
        truncateToWidth(theme.warning(this.activity), Math.max(0, width), '…'),
      ];
    }
    if (this.footer !== '') {
      const styled = this.footer.startsWith('error')
        ? theme.error(this.footer)
        : theme.muted(this.footer);
      // Wrapped, not cut: the trust statement and error reports are the
      // text an operator most needs whole. Capped at two rows.
      const wrapped = wrapTextWithAnsi(styled, Math.max(1, width));
      const shown = wrapped.slice(0, FOOTER_MAX_ROWS);
      if (wrapped.length > FOOTER_MAX_ROWS) {
        const last = shown.length - 1;
        shown[last] = truncateToWidth(
          `${shown[last] ?? ''} …`,
          Math.max(0, width),
          '…',
        );
      }
      return [
        ...lines,
        ...shown.map((line) => truncateToWidth(line, Math.max(0, width), '…')),
      ];
    }
    if (this.busySince !== undefined) {
      return [
        ...lines,
        renderWorkingLine(Date.now() - this.busySince, width, {
          queues: this.mode() === 'solo',
        }),
      ];
    }
    return [...lines, renderKeyHints(width, this.hints)];
  }

  invalidate(): void {
    this.editor.invalidate();
  }
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
  const tree = new AgentTreeView(undefined, { label: seed.label ?? 'solo' });
  // Issue #96 — the approval's inline slot. Below APPROVAL_MIN_WIDTH the
  // overlay cannot be composited (Pi's visible() gate refuses), so the
  // request renders in the transcript's own document. The document decides
  // for ITSELF at render time: the live alt-screen renders `root`, and the
  // transcript row must stay the ScrollView itself so the layout engine
  // sizes it (follow-end only works when the ScrollView is the row).
  const transcript = createTranscriptView({
    inline: (width: number): string[] | undefined =>
      approvalSurface.pending() !== undefined &&
      approvalSurface.usesInlineFallback(width)
        ? approvalSurface.renderInline(width)
        : undefined,
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
  const refreshWelcome = (): void => {
    // Issue #320: no `notice` argument — the app had a `setNotice` setter with
    // zero callers (the boot's notices go to stderr before the alt-screen
    // opens, #308), so it was deleted rather than tested. `welcomeLines` keeps
    // its optional parameter for a host that does have one to render.
    transcript.setWelcome(
      welcomeLines({ sessionId, model: modelLabel, hints: keyHints(keys) }),
    );
  };
  refreshWelcome();
  // Issue #327: the session mode is live state, not a boot-time literal:
  // the header and the status bar both read this cell, and Ctrl-G writes it
  // (refused while a turn runs). The seed is only the starting value.
  const sessionMode: { current: StatusMode } = { current: seed.mode };
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
  };
  const status = new StatusBar(barState);
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
    status.setMode(next);
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
  const editorRow = new EditorRow(
    editor,
    () => sessionMode.current,
    keyHints(keys),
  );
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
  const root = buildLayoutRoot({
    tree,
    header: lineComponent((width) =>
      renderHeader(width, { mode: sessionMode.current, model: modelLabel }),
    ),
    transcript: transcript.component,
    status,
    editor: editorRow,
    panel: { component: panelScroll, isOpen: () => mode !== 'closed' },
  });
  let busy = false;
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
  editor.onSubmit = (prompt: string): void => {
    if (submitHandler === undefined) return;
    // Issue #334: the loop decides which submit outcome this is. A queued
    // follow-up must not render as a pending turn (the queued row is its
    // feedback), and a refused prompt must not either — the loop's footer
    // says why. Both still pin the transcript: the operator asked to see
    // the tail.
    const outcome = submitHandler(prompt) ?? 'accepted';
    if (outcome === 'refused') {
      // Issue #334 (review): a refused prompt never eats the draft. Pi's
      // editor clears the draft BEFORE onSubmit fires, so the text has to go
      // back — the footer says why it was refused, and the operator can fix
      // the draft instead of retyping it.
      restoreDraft(prompt);
      return;
    }
    if (outcome === 'accepted') echoPendingPrompt(prompt);
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
  // The surface collects the verdict; the app owns the two places it can be
  // SEEN from (the overlay seat handed in by the composition root, and the
  // inline body below APPROVAL_MIN_WIDTH). pi-tui's hide() is permanent
  // ("cannot be shown again"), so each request gets a fresh ApprovalView and
  // the old one is dismissed first.
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
  let overlayHandle: ApprovalOverlayHandle | undefined;
  // Issue #328: the model picker overlay (at most one at a time).
  let modelPicker:
    | {
        readonly list: SelectList;
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
  const openPickerOverlay = (options: TuiPickerOptions): boolean => {
    if (overlayHost === undefined || !pickerFits()) return false;
    closeModelPicker();
    const rows = options.rows;
    const items: SelectItem[] = rows.map((row) => ({
      value: row.value,
      label: row.current === true ? `${row.label} (current)` : row.label,
      ...(row.description === undefined
        ? {}
        : { description: row.description }),
    }));
    const list = new SelectList(
      items,
      MODEL_PICKER_MAX_ROWS,
      modelPickerTheme(),
    );
    const current = rows.findIndex((row) => row.current === true);
    if (current >= 0) list.setSelectedIndex(current);
    list.onSelect = (item: SelectItem): void => {
      closeModelPicker();
      options.onSelect(item.value);
    };
    list.onCancel = (): void => {
      closeModelPicker(true);
    };
    modelPicker = {
      list,
      handle: overlayHost.showOverlay(list, modelPickerOverlayOptions()),
      onCancel: options.onCancel,
    };
    overlayHost.requestRender?.();
    return true;
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
  let overlayView: ApprovalView | undefined;
  const dismissOverlay = (): void => {
    if (overlayView !== undefined && overlayHandle !== undefined) {
      // unfocus-first: after hide() Pi's unfocus early-returns (the entry is
      // gone), so the explicit editor target would be lost.
      overlayHandle.unfocus({ target: editor });
      overlayView.focused = false;
      overlayHandle.hide();
    }
    overlayView = undefined;
    overlayHandle = undefined;
  };
  // Bring the overlay in line with the surface. Called after every decision
  // and after every ask, so the shown request is always the pending one.
  const syncOverlay = (): void => {
    const request = approvalSurface.pending();
    if (request === undefined) {
      if (overlayView !== undefined) dismissOverlay();
      return;
    }
    if (overlayHandle !== undefined) {
      // A different request while one was shown: the previous view is spent.
      if (overlayView?.getRequest().key === request.key) return;
      dismissOverlay();
    }
    const host = overlayHost;
    if (host === undefined) return;
    const view = new ApprovalView({
      request,
      // The decision itself is taken by the app (it owns the loop); this
      // callback exists because ApprovalView requires the seat, and it must
      // not double-apply — the loop's own handler is the single path, and it
      // is where allow keys are gated while the dialog cannot show the whole
      // command (the surface's fitCheck, issue #316).
      onDecision: () => {},
      // Issue #315: the hints stay locked until the surface arms.
      isArmed: () => approvalSurface.isArmed(),
      commandPage: () => approvalSurface.commandPage(),
      // Issue #316: Pi cuts the overlay from the bottom at its height cap, so
      // the dialog fits the rows the live terminal leaves it.
      maxRows: () =>
        host.terminal === undefined
          ? undefined
          : approvalOverlayRows(host.terminal.rows),
      keyOverrides: approvalSurface.keys() as ApprovalKeyOverrides,
    });
    overlayView = view;
    overlayHandle = showApprovalOverlay(host, view);
  };
  const settleApproval = (): void => {
    syncOverlay();
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
      if (
        isKeyRepeat(data) &&
        (approvalSurface.isShowing() || keys.isGlobalKey(keyId))
      ) {
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
      if (approvalSurface.isShowing() && approvalSurface.decide(data)) {
        settleApproval();
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #315: the approval is a capturing modal. While it shows, every
      // key it did not take — prose typed ahead for the next prompt, and a
      // decision key pressed inside the arming window — is dropped rather
      // than reaching the draft. Only the loop's global keys still act.
      // Issue #316: `v` pages a long command in the dialog (never decides).
      if (
        approvalSurface.isShowing() &&
        keys.actionFor('approval', keyId) === 'approval.page' &&
        approvalSurface.nextCommandPage()
      ) {
        return { quit: false, consumed: true, cancel: false };
      }
      if (approvalSurface.isShowing() && !keys.isGlobalKey(keyId)) {
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
        } else if (action === 'app.exit' || action === 'app.interrupt') {
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
        if (action === 'app.exit' || action === 'app.interrupt') {
          closeModelPicker(true);
          return { quit: false, consumed: true, cancel: false };
        }
        modelPicker.list.handleInput(data);
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #302: Esc and Ctrl-C share one path. Both are classified as
      // cancel (the root decides: a running turn aborts and the session
      // stays; idle it exits), and NEITHER throws away a composed draft —
      // the first press clears it, a second press on the empty draft quits.
      // A pending approval is denied first: nobody is left waiting on a
      // verdict that can no longer arrive (the turn would otherwise hang to
      // the lane's timeout).
      const cancelOrClearDraft = (): TuiInputResult => {
        if (approvalSurface.isShowing()) {
          approvalSurface.cancelPending();
          settleApproval();
        }
        if (!busy && editor.getText() !== '') {
          editor.setText('');
          const key = keys.label(
            action === 'app.exit' ? 'app.exit' : 'app.interrupt',
          );
          editorRow.setFooter(
            `${key}: draft cleared — press ${key} again on an empty draft to quit`,
          );
          return { quit: false, consumed: true, cancel: false };
        }
        // Idle Esc keeps its shipped classification (quit, not cancel);
        // Ctrl-C is always a cancel and a BUSY Esc is one too, which is what
        // makes the root abort the turn instead of exiting.
        return {
          quit: true,
          consumed: true,
          cancel: action === 'app.interrupt' || busy,
        };
      };
      if (action === 'app.interrupt' || action === 'app.exit') {
        return cancelOrClearDraft();
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
          editorRow.setFooter('mode: finish the current turn before switching');
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
      const lane = state.lanes.get(seed.sessionId);
      editorRow.setActivity(
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
      const cells = entriesToCells(entries);
      transcript.applyLaneSnapshot({ laneId: sessionId }, cells, revision);
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
      busy = next;
      // Issue #334: the editor stays ENABLED through a turn. Enter is no
      // longer a silent no-op while the lane works: the loop submits it as
      // a follow-up into the conversation's inbox, and Alt+Enter steers.
      editorRow.busySince = next ? Date.now() : undefined;
      editorRow.setFooter('');
      if (!next && pendingPrompt !== undefined) {
        pendingPrompt = undefined;
        pendingImages = [];
        transcript.setPendingPrompt(undefined);
      }
    },
    busyElapsedMs: (now: number = Date.now()): number | undefined =>
      editorRow.busySince === undefined
        ? undefined
        : Math.max(0, now - editorRow.busySince),
    toggleToolOutput: (): boolean => transcript.toggleExpanded(),
    setApprovalsSkipped: (skipped: boolean): void => {
      status.setApprovalsSkipped(skipped);
    },
    mode: (): StatusMode => sessionMode.current,
    setMode,
    isBusy: (): boolean => busy,
    setEditorFooter: (text: string): void => {
      editorRow.setFooter(text);
    },
    restoreDraft: (prompt: string): void => {
      restoreDraft(prompt);
    },
    openModelPicker: (options: TuiModelPickerOptions): boolean => {
      const rows = options.rows;
      return openPickerOverlay({
        rows: rows.map((row) => ({
          value: `${row.provider}/${row.id}`,
          label: row.label,
          ...(row.note === undefined ? {} : { description: row.note }),
          ...(row.current === true ? { current: true } : {}),
        })),
        onSelect: (value) => {
          const picked = rows.find(
            (row) => `${row.provider}/${row.id}` === value,
          );
          if (picked !== undefined) options.onSelect(picked);
        },
        ...(options.onCancel === undefined
          ? {}
          : { onCancel: options.onCancel }),
      });
    },
    openPicker: (options: TuiPickerOptions): boolean =>
      openPickerOverlay(options),
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
      tree.reset();
      mode = 'closed';
      diffPanel.setChanges([]);
      journalPanel.setChanges([]);
      diffPanel.setToolCall(null);
      editor.setText('');
      editorRow.setFooter('');
      applyModel(options.model, options.thinking);
      status.setState({
        ...status.getState(),
        sessionId: options.sessionId,
      });
      status.setRows([...(options.usage ?? [])]);
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
      diffPanel.setChanges(rows);
      journalPanel.setChanges(rows);
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
      // Issue #96: the live screen's render request, so an ask that arrives
      // from the lane's async turn paints a frame immediately. Optional on
      // the seam (see ApprovalOverlayTui) — a host that lacks it still gets
      // the overlay, just drawn on the next frame the loop already renders.
      approvalSurface.renderRequest = (): void => {
        host.requestRender?.();
      };
      // Issue #316: whether the shown dialog fits the overlay the live
      // terminal leaves it (the same width and row rule Pi applies). Below
      // APPROVAL_MIN_WIDTH the inline slot takes its place in the transcript,
      // which has no height cap; a host that reports no size keeps the fixed
      // layout.
      approvalSurface.fitCheck = (): boolean => {
        const request = approvalSurface.pending();
        const terminal = host.terminal;
        if (request === undefined || terminal === undefined) return true;
        if (approvalSurface.usesInlineFallback(terminal.columns)) return true;
        return approvalFitsOverlay(
          request,
          approvalOverlayWidth(terminal.columns),
          approvalOverlayRows(terminal.rows),
        );
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
