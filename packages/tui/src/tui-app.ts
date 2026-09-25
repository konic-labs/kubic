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
//   Ctrl-O           toggle the diff panel (this run's changes)
//   Ctrl-R           toggle the journal panel (the whole session)
//   Ctrl-C           cancel the in-flight turn; quit when idle (a second
//                    Ctrl-C during a turn also quits)
//   Esc              quit
//   Ctrl-D           quit on an empty draft (delete-forward while typing)

import type { KubicPresentationState } from '../../core/src/presentation.js';
import {
  type ApprovalSurface,
  createApprovalSurface,
} from './approval-surface.js';
import type {
  ApprovalDecision,
  ApprovalOverlayHandle,
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from './approval-view.js';
import { ApprovalView, showApprovalOverlay } from './approval-view.js';
import { PromptEditor } from './editor-view.js';
import { entriesToCells, type LaneEntryLike } from './lane-cells.js';
import { buildLayoutRoot, type Viewport } from './layout.js';
import {
  StatusBar,
  type StatusBarState,
  type StatusUsageRow,
} from './status-bar.js';
import { createTranscriptView, type TranscriptView } from './transcript.js';
import { AgentTreeView, type LaneEventLike } from './tree.js';
import type { Component, VStack } from './tui-boundary.js';
import { parseKey } from './tui-boundary.js';
import {
  DiffPanel,
  type JournalChangeLike,
  JournalPanel,
  type PanelMode,
} from './view-panel.js';

export type {
  JournalChangeLike,
  LaneEntryLike,
  LaneEventLike,
  PanelMode,
  Viewport,
};

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
}

// §66 replication: the TUI holds no authority — it reads the replicated
// snapshot only. The model id is runtime (not presentation state), so it
// arrives alongside.
export function seedFromPresentation(
  state: KubicPresentationState,
  model: string,
): TuiAppSeed {
  return { sessionId: state.session.sessionId, model };
}

export interface TuiInputResult {
  readonly quit: boolean;
  readonly consumed: boolean;
  // Issue #88: Ctrl-C during a turn aborts the operation instead of
  // exiting. The root owns the busy/idle decision; the app only
  // classifies the key, so the count and the exit stay in one place.
  readonly cancel: boolean;
}

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

export interface TuiApp {
  readonly root: VStack;
  readonly tree: AgentTreeView;
  readonly transcript: TranscriptView;
  readonly status: StatusBar;
  readonly editor: PromptEditor;
  render(width: number): string[];
  handleInput(data: string): TuiInputResult;
  finalDocument(width: number): string[];
  applyLaneEvent(event: LaneEventLike): void;
  applyLaneEntries(entries: ReadonlyArray<LaneEntryLike>): void;
  setUsage(rows: ReadonlyArray<StatusUsageRow>): void;
  onSubmit(handler: (prompt: string) => void): void;
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  setEditorFooter(text: string): void;
  // Issue #96: the §17 inspectable pair.
  setJournalChanges(rows: ReadonlyArray<JournalChangeLike>): void;
  setJournalFilter(filter: JournalFilterLike): void;
  setDiffToolCall(toolCallId: string | null): void;
  panelMode(): PanelMode;
  openPanel(mode: PanelMode): void;
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

// The layout's fourth row is one component (issue #22 owns arrangement
// only), so the editor and its one-line hint slot are composed here rather
// than widening the layout.
class EditorRow implements Component {
  private readonly editor: PromptEditor;
  private footer: string;

  constructor(editor: PromptEditor) {
    this.editor = editor;
    this.footer = '';
  }

  setFooter(text: string): void {
    this.footer = text;
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    if (this.footer === '') return lines;
    const hint =
      this.footer.length <= width
        ? this.footer
        : `${this.footer.slice(0, Math.max(0, width - 1))}…`;
    return [...lines, hint];
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

export function createTuiApp(seed: TuiAppSeed): TuiApp {
  const tree = new AgentTreeView(undefined, { label: seed.label ?? 'solo' });
  const transcript = createTranscriptView();
  transcript.appendDelta({
    id: 'session',
    kind: 'text',
    append: `session ${seed.sessionId} · model ${seed.model}`,
  });
  const barState: StatusBarState = {
    model: seed.model,
    thinking: seed.thinking ?? 'off',
    rows: [],
    mode: 'solo',
    approvalsSkipped: false,
    sessionId: seed.sessionId,
  };
  const status = new StatusBar(barState);
  const editor = new PromptEditor();
  const editorRow = new EditorRow(editor);
  // Issue #96 — the approval's inline slot. Below APPROVAL_MIN_WIDTH the
  // overlay cannot be composited (Pi's visible() gate refuses), so the
  // request renders here, in the transcript's own row. The slot decides for
  // ITSELF at render time rather than reading a field the caller sets: the
  // live alt-screen renders `root` (not the app's own render()), so a body
  // computed outside the slot would never appear on the real path — the bug
  // the end-to-end narrow test caught.
  const transcriptSlot: Component = {
    render: (width: number): string[] =>
      approvalSurface.pending() !== undefined &&
      approvalSurface.usesInlineFallback(width)
        ? approvalSurface.renderInline(width)
        : transcript.render(width),
    invalidate: (): void => {
      transcript.component.invalidate();
    },
  };
  // Issue #96 — the panel row. Both panels stay mounted and keep their rows;
  // the layout hides the row entirely while the mode is 'closed', so a
  // keypress never leaves blank space behind.
  const diffPanel = new DiffPanel();
  const journalPanel = new JournalPanel();
  let mode: PanelMode = 'closed';
  const panelBody: Component = {
    render: (width: number): string[] =>
      mode === 'diff' ? diffPanel.render(width) : journalPanel.render(width),
    invalidate: (): void => {
      diffPanel.invalidate();
      journalPanel.invalidate();
    },
  };
  const root = buildLayoutRoot({
    tree,
    transcript: transcriptSlot,
    status,
    editor: editorRow,
    panel: { component: panelBody, isOpen: () => mode !== 'closed' },
  });
  let busy = false;
  let revision = 0;
  let submitHandler: ((prompt: string) => void) | undefined;
  editor.onSubmit = (prompt: string): void => {
    submitHandler?.(prompt);
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
  const approvalSurface = seed.approvalSurface ?? createApprovalSurface();
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
  approvalSurface.checkKeys();
  let overlayHost: ApprovalOverlayTui | undefined;
  let overlayHandle: ApprovalOverlayHandle | undefined;
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
    if (overlayHost === undefined) return;
    const view = new ApprovalView({
      request,
      // The decision itself is taken by the app (it owns the loop); this
      // callback exists because ApprovalView requires the seat, and it must
      // not double-apply — the loop's own handler is the single path.
      onDecision: () => {},
    });
    overlayView = view;
    overlayHandle = showApprovalOverlay(overlayHost, view);
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
      const keyId = keyIdOf(data);
      // Issue #96: a shown approval owns the decision keys FIRST — above every
      // global binding. Answering with Esc must deny the request, not quit the
      // session; the operator can still quit after the request settles. A key
      // the surface does not claim falls through to the normal loop (so the
      // draft, Ctrl-T, Ctrl-O/R and the rest keep working).
      if (approvalSurface.isShowing() && approvalSurface.decide(data)) {
        settleApproval();
        return { quit: false, consumed: true, cancel: false };
      }
      if (keyId === 'ctrl+c') {
        // Always classified as cancel; the root decides whether the process
        // exits (idle) or the in-flight turn aborts (busy). A pending approval
        // is denied first: nobody is left waiting on a verdict that can no
        // longer arrive (the turn would otherwise hang to the lane's timeout).
        if (approvalSurface.isShowing()) {
          approvalSurface.cancelPending();
          settleApproval();
        }
        return { quit: true, consumed: true, cancel: true };
      }
      if (keyId === 'escape') return quit();
      if (keyId === 'ctrl+d') {
        // Ctrl-D quits only on an empty draft — the shell convention. While
        // typing it stays Pi's delete-forward, so the key is never a silent
        // no-op in either state.
        if (editor.getText() !== '') {
          editor.handleInput(data);
          return { quit: false, consumed: true, cancel: false };
        }
        return quit();
      }
      if (keyId === 'ctrl+t') {
        tree.handleInput('t');
        return { quit: false, consumed: true, cancel: false };
      }
      // Issue #96: Ctrl-O / Ctrl-R toggle the §17 inspectable pair. Both are
      // free of pi-tui's own bindings (probed: editor bindings claim
      // a/b/c/d/e/f/g/j/k/u/w/y, the alt-screen claims the arrows, home/end,
      // page keys and ctrl+shift+*), and both are classified through the same
      // seam as every other global key.
      if (keyId === 'ctrl+o') {
        mode = mode === 'diff' ? 'closed' : 'diff';
        return { quit: false, consumed: true, cancel: false };
      }
      if (keyId === 'ctrl+r') {
        mode = mode === 'journal' ? 'closed' : 'journal';
        return { quit: false, consumed: true, cancel: false };
      }
      editor.handleInput(data);
      return { quit: false, consumed: true, cancel: false };
    },
    finalDocument: (width: number): string[] => root.render(width),
    applyLaneEvent: (event: LaneEventLike): void => {
      tree.update(event);
      // The diff panel follows the run: a tool call that starts or ends is
      // what "the current run's changes" means, so the panel's default
      // selection tracks it (an explicit setDiffToolCall still wins).
      if (
        (event.type === 'tool-start' || event.type === 'tool-end') &&
        typeof event.toolCallId === 'string'
      ) {
        diffPanel.followToolCall(event.toolCallId);
      }
    },
    applyLaneEntries: (entries: ReadonlyArray<LaneEntryLike>): void => {
      // The revision counter makes every apply a fresh snapshot: the
      // transcript replaces its cells instead of appending duplicates.
      revision += 1;
      transcript.applyLaneSnapshot(
        { laneId: seed.sessionId },
        entriesToCells(entries),
        revision,
      );
    },
    setUsage: (rows: ReadonlyArray<StatusUsageRow>): void => {
      status.setRows(rows);
    },
    onSubmit: (handler: (prompt: string) => void): void => {
      submitHandler = handler;
    },
    setBusy: (next: boolean): void => {
      busy = next;
      // Submit is disabled for the duration of a turn: the lane refuses a
      // second concurrent accept, so the loop never offers one.
      editor.setDisabled(next);
      editorRow.setFooter(next ? 'working… Ctrl-C cancels' : '');
    },
    isBusy: (): boolean => busy,
    setEditorFooter: (text: string): void => {
      editorRow.setFooter(text);
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
    openPanel: (next: PanelMode): void => {
      mode = next;
    },
    attachApprovalOverlay: (host: ApprovalOverlayTui): void => {
      overlayHost = host;
      // Issue #96: the live screen's render request, so an ask that arrives
      // from the lane's async turn paints a frame immediately. Optional on
      // the seam (see ApprovalOverlayTui) — a host that lacks it still gets
      // the overlay, just drawn on the next frame the loop already renders.
      approvalSurface.renderRequest = (): void => {
        host.requestRender?.();
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
