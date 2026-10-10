// Interactive TUI controller over the lane.
// Presentation only: the controller replicates the core
// KubicPresentationState (contracts only, no authority) into the
// tested views (tree, transcript, status) arranged by the
// layout root. The composition root (apps/kubic) owns the lane
// boot, the alt-screen lifecycle, and shutdown.
//
// The app is a set of controllers over one shared core (app/): the session
// and turn views, the panel row, the overlays, the palette, block mode, the
// approval wiring and the quit arming; app/input-router.ts routes every key
// through one precedence table.
//
// Key map (the shipped loop; docs/cli/tui-keys.md mirrors it):
//   Enter            submit the draft
//   Ctrl-J, Shift+Enter, `\`+Enter   newline (multi-line entry)
//   Ctrl-T           show / hide the tree (it starts hidden)
//   Ctrl-O           toggle the diff panel (this run's changes)
//   Ctrl-R           toggle the journal panel (the whole session)
//   Ctrl-X           expand / collapse every tool output block
//   Ctrl-C           interrupt the in-flight turn; idle: clear the draft,
//                    then press twice within 2 s to quit
//   Alt+Enter        steer the running turn with the draft (submits it when idle)
//   Esc              close the dropdown or overlay, else interrupt the
//                    running turn — never quits; idle on an empty draft it
//                    walks the transcript's blocks
//   Ctrl-D           quit on an empty draft (delete-forward while typing)
//
// The chrome is three one-row surfaces: the header (project, branch,
// session, posture, clock), the status line (model, context, cost, journal,
// state word) and the context-aware key-hint row. Command replies, turn
// outcomes and the working line sit on a transient notice row above the
// editor.
import { ApprovalsController } from './app/approvals.js';
import { BlockMode } from './app/blocks.js';
import { AppCore } from './app/core.js';
import { routeInput } from './app/input-router.js';
import { buildAppLayout } from './app/layout.js';
import { OverlayController } from './app/overlays.js';
import { PaletteController } from './app/palette-controller.js';
import { PanelController } from './app/panel.js';
import { QuitArming } from './app/quit.js';
import { SessionView } from './app/session-view.js';
import { TurnView } from './app/turn-view.js';
import type { TuiApp, TuiAppSeed } from './app/types.js';
import { formatStatusCost, summarizeStatusRows } from './status-bar.js';

export type {
  TuiApp,
  /** @internal */ TuiApprovalRequest,
  TuiAppSeed,
  /** @internal */ TuiPaletteSources,
  TuiPickerRow,
  TuiSubmitOutcome,
  TuiWorkspace,
} from './app/types.js';
export type { JournalChangeLike } from './view-panel.js';

export function createTuiApp(seed: TuiAppSeed): TuiApp {
  const core = new AppCore(seed);
  core.session = new SessionView(core);
  core.turn = new TurnView(core);
  core.panel = new PanelController();
  core.quit = new QuitArming(core);
  core.overlays = new OverlayController(core);
  core.palette = new PaletteController(core);
  core.blocks = new BlockMode(core);
  core.approvals = new ApprovalsController(core);
  const root = buildAppLayout(core);
  const { editor, transcript, status, session, turn, panel } = core;
  editor.allowEmptySubmit = (): boolean => turn.pendingAttachments > 0;
  editor.onSubmit = (prompt: string): void => {
    turn.submit(prompt);
  };
  return {
    root,
    tree: core.tree,
    transcript,
    status,
    editor,
    render: (width) => root.render(width),
    handleInput: (data) => routeInput(core, data),
    finalDocument: (width) => root.render(width),
    presentationSeed: () => ({
      sessionId: seed.sessionId,
      model: session.modelLabel,
      approvalsSkipped: status.getState().approvalsSkipped,
    }),
    applyPresentation: (state) => turn.applyPresentation(state),
    applyLaneEntries: (entries) => turn.applyLaneEntries(entries),
    setUsage: (rows) => status.setRows(rows),
    setStream: (text) => transcript.setStream(text),
    setModel: (next, thinking) => session.applyModel(next, thinking),
    setContextLimits: (limits) => {
      status.setState({
        ...status.getState(),
        contextWindow: limits.contextWindow,
        compactionThreshold: limits.compactionThreshold,
      });
    },
    setContextTokens: (tokens) => {
      status.setState({ ...status.getState(), contextTokens: tokens });
    },
    onSubmit: (handler) => {
      core.submitHandler = handler;
    },
    setBusy: (next) => turn.setBusy(next),
    isBusy: () => turn.busy,
    busyElapsedMs: (now = Date.now()) => turn.busyElapsedMs(now),
    toggleToolOutput: () => transcript.toggleExpanded(),
    setApprovalsSkipped: (skipped) => status.setApprovalsSkipped(skipped),
    setEditorFooter: (text) => core.noticeRow.setFooter(text),
    setCancelling: (next) => turn.setCancelling(next),
    setTurnOutcome: (outcome, info = {}) => turn.setTurnOutcome(outcome, info),
    setWorkspace: (next) => session.setWorkspace(next),
    setPendingEcho: (prompt) => turn.setPendingEcho(prompt),
    setPendingImages: (images) => turn.setPendingImages(images),
    setPendingAttachments: (count) => {
      turn.pendingAttachments = count;
    },
    restoreDraft: (prompt) => turn.restoreDraft(prompt),
    setAutocomplete: (provider) => editor.setAutocomplete(provider),
    seedPromptHistory: (prompts) => editor.seedHistory(prompts),
    openModelPicker: (options) => core.overlays.openModelPicker(options),
    isModelPickerOpen: () => core.overlays.picker !== undefined,
    openPicker: (options) => core.overlays.openPicker(options),
    openPalette: (sources) => core.palette.open(sources),
    isPaletteOpen: () => core.palette.current !== undefined,
    openKeysOverlay: () => core.overlays.openKeys(),
    openConfirm: (options) => core.overlays.openConfirm(options),
    isConfirmOpen: () => core.overlays.confirm !== undefined,
    setRecentSessions: (sessions) => session.setRecentSessions(sessions),
    appendNotice: (lines) => turn.appendNotice(lines),
    // `/session` — id, workspace, model, thinking level, tokens and
    // cost from the rows the status bar already carries (one source of
    // truth). `cwd` comes from the boot (the app never guesses a workspace).
    sessionReport: (cwd) => {
      const state = status.getState();
      const summary = summarizeStatusRows(state.rows);
      const where = cwd === undefined ? '' : ` in ${cwd}`;
      return `session ${session.sessionId}${where} · ${state.model} · thinking ${state.thinking} · in ${summary.input} out ${summary.output} (cached ${summary.cacheRead}) · ${formatStatusCost(summary.costTotal)}`;
    },
    // `/new` and `/resume` — every session-scoped surface starts over
    // (transcript, tree, usage, panels, echoes) under the next session's
    // identity, without recreating the app.
    resetSession: (options) => {
      session.sessionId = options.sessionId;
      turn.reset(options.sessionId, options.usage?.length ?? 0);
      panel.reset();
      editor.setText('');
      core.noticeRow.setFooter('');
      session.applyModel(options.model, options.thinking);
      status.setState({
        ...status.getState(),
        sessionId: options.sessionId,
        journalChanges: 0,
        contextTokens: undefined,
      });
      status.setRows([...(options.usage ?? [])]);
      // The old session's blocks are gone.
      core.blocks.closeViewer();
      core.blocks.exit();
      session.showWelcome();
    },
    setJournalChanges: (rows) => {
      turn.setJournalRows(rows);
      panel.setChanges(rows);
      status.setState({ ...status.getState(), journalChanges: rows.length });
    },
    setJournalFilter: (filter) => panel.setFilter(filter),
    setDiffToolCall: (toolCallId) => panel.diffPanel.setToolCall(toolCallId),
    panelMode: () => panel.mode,
    openPanel: (mode) => panel.set(mode),
    panelScrollBy: (lines) => panel.scroll.scrollBy(Math.trunc(lines)),
    panelScrollTo: (line) => panel.scroll.scrollTo(Math.trunc(line)),
    panelScrollTop: () => panel.scroll.scrollTop,
    panelJumpFile: (delta) => panel.jumpFile(delta),
    attachApprovalOverlay: (host) => core.approvals.attach(host),
    requestApproval: (request) => core.approvals.request(request),
    hasPendingApproval: () => core.approvalSurface.isShowing(),
  };
}
