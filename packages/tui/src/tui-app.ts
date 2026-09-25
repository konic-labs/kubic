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
// Key map (the shipped loop; docs/cli/commands.md mirrors it):
//   Enter            submit the draft
//   Ctrl-J, Shift+Enter, `\`+Enter   newline (multi-line entry)
//   Ctrl-T           toggle the tree
//   Ctrl-C           cancel the in-flight turn; quit when idle (a second
//                    Ctrl-C during a turn also quits)
//   Esc              quit
//   Ctrl-D           quit on an empty draft (delete-forward while typing)

import type { KubicPresentationState } from '../../core/src/presentation.js';
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

export type { LaneEntryLike, LaneEventLike, Viewport };

export interface TuiAppSeed {
  readonly sessionId: string;
  readonly model: string;
  readonly thinking?: string;
  readonly label?: string;
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
  const root = buildLayoutRoot({
    tree,
    transcript: transcript.component,
    status,
    editor: editorRow,
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
      if (keyId === 'ctrl+c') {
        // Always classified as cancel; the root decides whether the process
        // exits (idle) or the in-flight turn aborts (busy).
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
      editor.handleInput(data);
      return { quit: false, consumed: true, cancel: false };
    },
    finalDocument: (width: number): string[] => root.render(width),
    applyLaneEvent: (event: LaneEventLike): void => {
      tree.update(event);
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
  };
}
