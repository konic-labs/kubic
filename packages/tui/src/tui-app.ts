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
//   Ctrl-X           expand / collapse every tool output block
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
import {
  entriesToCells,
  type LaneEntryLike,
  sanitizeLaneText,
} from './lane-cells.js';
import { buildLayoutRoot, type Viewport } from './layout.js';
import {
  StatusBar,
  type StatusBarState,
  type StatusMode,
  type StatusUsageRow,
} from './status-bar.js';
import {
  formatElapsed,
  spinnerFrame,
  tuiTheme,
  WORDMARK_GLYPH,
  WORDMARK_NAME,
  WORDMARK_TAGLINE,
} from './theme.js';
import { createTranscriptView, type TranscriptView } from './transcript.js';
import { AgentTreeView, type LaneEventLike } from './tree.js';
import type { Component, VStack } from './tui-boundary.js';
import {
  isKeyRelease,
  isKeyRepeat,
  parseKey,
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
  // Issue #307 (§17, §18): the always-visible mode indicator. Both fields
  // are REQUIRED — seeded from the posture the composition root actually
  // installed — so no call site can silently default a full-access session
  // to 'approvals:on'.
  readonly mode: StatusMode;
  readonly approvalsSkipped: boolean;
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

// The keys handleInput claims before the editor (see the key map above).
const GLOBAL_KEYS: ReadonlySet<string> = new Set([
  'ctrl+c',
  'escape',
  'ctrl+d',
  'ctrl+t',
  'ctrl+o',
  'ctrl+r',
  'ctrl+x',
]);

function isGlobalKey(keyId: string | undefined): boolean {
  return keyId !== undefined && GLOBAL_KEYS.has(keyId);
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
  // TUI polish: the solo notice lives in the welcome block (wrapped in
  // full) instead of a truncated footer line.
  setNotice(text: string): void;
  // Ms since the in-flight turn started (undefined when idle); the root's
  // spinner timer re-renders while this is defined.
  busyElapsedMs(now?: number): number | undefined;
  // Ctrl-X: expand / collapse tool output blocks.
  toggleToolOutput(): boolean;
  // Issue #307: a posture change (the policy's own predicate) reaches the
  // indicator on the very next frame.
  setApprovalsSkipped(skipped: boolean): void;
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

// The key hints shown under the editor while idle.
export const KEY_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['enter', 'send'],
  ['ctrl+j', 'newline'],
  ['ctrl+x', 'expand output'],
  ['ctrl+o', 'diff'],
  ['ctrl+r', 'journal'],
  ['ctrl+t', 'tree'],
  ['esc', 'quit'],
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
export function renderWorkingLine(elapsedMs: number, width: number): string {
  const theme = tuiTheme();
  const line = `${theme.warm(spinnerFrame(elapsedMs))} ${theme.warm('working…')} ${theme.muted(`${formatElapsed(elapsedMs)} · ctrl+c cancels`)}`;
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
}): string[] {
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
  const half = Math.ceil(KEY_HINTS.length / 2);
  lines.push(
    `  ${renderKeyHints(Number.POSITIVE_INFINITY, KEY_HINTS.slice(0, half))}`,
  );
  lines.push(
    `  ${renderKeyHints(Number.POSITIVE_INFINITY, KEY_HINTS.slice(half))}`,
  );
  return lines;
}

// The layout's fourth row is one component (issue #22 owns arrangement
// only), so the editor and its one-line hint slot are composed here rather
// than widening the layout. The slot shows, in order of precedence: an
// explicit footer (outcome / error / cancelling), the working indicator
// while a turn runs, else the key hints.
class EditorRow implements Component {
  private readonly editor: PromptEditor;
  private footer: string;
  busySince: number | undefined;

  constructor(editor: PromptEditor) {
    this.editor = editor;
    this.footer = '';
    this.busySince = undefined;
  }

  setFooter(text: string): void {
    this.footer = sanitizeLaneText(text);
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    const theme = tuiTheme();
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
      return [...lines, renderWorkingLine(Date.now() - this.busySince, width)];
    }
    return [...lines, renderKeyHints(width)];
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

export function createTuiApp(seed: TuiAppSeed): TuiApp {
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
  let notice = '';
  const refreshWelcome = (): void => {
    transcript.setWelcome(
      welcomeLines({ sessionId: seed.sessionId, model: seed.model, notice }),
    );
  };
  refreshWelcome();
  const barState: StatusBarState = {
    model: seed.model,
    thinking: seed.thinking ?? 'off',
    rows: [],
    mode: seed.mode,
    approvalsSkipped: seed.approvalsSkipped,
    sessionId: seed.sessionId,
  };
  const status = new StatusBar(barState);
  const editor = new PromptEditor();
  const editorRow = new EditorRow(editor);
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
    header: lineComponent((width) =>
      renderHeader(width, { mode: seed.mode, model: seed.model }),
    ),
    transcript: transcript.component,
    status,
    editor: editorRow,
    panel: { component: panelBody, isOpen: () => mode !== 'closed' },
  });
  let busy = false;
  let revision = 0;
  let submitHandler: ((prompt: string) => void) | undefined;
  let pendingPrompt: string | undefined;
  let promptCells = 0;
  let promptCellsAtSubmit = 0;
  editor.onSubmit = (prompt: string): void => {
    if (submitHandler === undefined) return;
    // Echo the prompt at once: the lane commits it asynchronously, and a
    // prompt that vanishes until the turn ends reads as a dropped key.
    pendingPrompt = sanitizeLaneText(prompt);
    promptCellsAtSubmit = promptCells;
    transcript.setPendingPrompt(pendingPrompt);
    transcript.rePin();
    submitHandler(prompt);
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
        (approvalSurface.isShowing() || isGlobalKey(keyId))
      ) {
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
      if (keyId === 'ctrl+x') {
        transcript.toggleExpanded();
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
      const cells = entriesToCells(entries);
      transcript.applyLaneSnapshot({ laneId: seed.sessionId }, cells, revision);
      // The echoed prompt is dropped once the lane has committed a NEW
      // prompt cell (counted, not matched by text: an identical resubmit
      // must not clear on the previous turn's cell).
      promptCells = cells.filter((cell) => cell.kind === 'prompt').length;
      if (pendingPrompt !== undefined && promptCells > promptCellsAtSubmit) {
        pendingPrompt = undefined;
        transcript.setPendingPrompt(undefined);
      }
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
      editorRow.busySince = next ? Date.now() : undefined;
      editorRow.setFooter('');
      if (!next && pendingPrompt !== undefined) {
        pendingPrompt = undefined;
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
    setNotice: (text: string): void => {
      notice = sanitizeLaneText(text);
      refreshWelcome();
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
