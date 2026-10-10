// The app's views, arranged by the layout root: the header, the tree, the
// transcript, the panel row, the notice row, the editor slot (the prompt
// editor, or the approval card while an ask is pending), the status line and
// the key-hint row.
import { renderApprovalCard } from '../approval-card.js';
import {
  type HintContext,
  keyCap,
  keyHintSet,
  renderHeader,
  shortSessionId,
} from '../chrome.js';
import { EDITOR_FRAME_CELLS, frameEditorLines } from '../editor-frame.js';
import {
  CombinedAutocomplete,
  FileMentionAutocomplete,
} from '../file-mentions.js';
import { buildLayoutRoot } from '../layout.js';
import {
  SLASH_COMMANDS,
  SlashCommandAutocomplete,
  skillCommandSpecs,
} from '../slash-commands.js';
import { StatusBar } from '../status-bar.js';
import { tuiTheme } from '../theme.js';
import type { Component, VStack } from '../tui-boundary.js';
import { isKittyProtocolActive } from '../tui-boundary.js';
import { renderKeyHintRow } from '../ui/key-hints.js';
import type { AppCore } from './core.js';
import { NoticeRow } from './notice-row.js';

// The queue box's prompt mid-turn.
const QUEUE_PLACEHOLDER = 'type to queue — sent when this turn ends';

export function buildAppLayout(core: AppCore): VStack {
  const { seed } = core;
  // The state word reads the app's live turn facts per frame.
  core.status = new StatusBar(
    {
      model: core.session.modelLabel,
      thinking: core.session.thinkingLabel,
      rows: [],
      approvalsSkipped: seed.approvalsSkipped,
      sessionId: seed.sessionId,
      ...(seed.contextWindow === undefined
        ? {}
        : { contextWindow: seed.contextWindow }),
      ...(seed.compactionThreshold === undefined
        ? {}
        : { compactionThreshold: seed.compactionThreshold }),
    },
    {
      live: () => ({
        turn: core.turn.turnState(),
        busySince: core.noticeRow.busySince,
        // The policy's own word on a turn's edit batch.
        ...(seed.editsApprovedThisTurn?.() === true ? { turnEdits: true } : {}),
      }),
    },
  );
  wireAutocomplete(core);
  core.noticeRow = new NoticeRow(() => core.turn.workingInfo());
  return buildLayoutRoot({
    header: lineComponent((width) => header(core, width)),
    tree: core.tree,
    treeVisible: () => !core.tree.isCollapsed(),
    transcript: core.transcript.component,
    panel: {
      component: core.panel.scroll,
      isOpen: () => core.panel.isOpen(),
      top: core.panel.top,
      bottom: core.panel.bottom,
    },
    notice: core.noticeRow,
    editor: editorSlot(core),
    status: core.status,
    hints: lineComponent((width) => {
      const confirm = core.overlays.confirm?.options;
      const set = keyHintSet(hintContext(core), core.keys, {
        files: seed.listFiles !== undefined,
        // Shift+Enter is a newline only where the terminal reports it.
        newline: isKittyProtocolActive() ? '⇧⏎' : '^J',
        ...(core.panel.mode === 'closed' ? {} : { panel: core.panel.mode }),
        ...(confirm === undefined
          ? {}
          : {
              confirm: {
                key: keyCap(confirm.confirmKey),
                label: confirm.confirmAction ?? 'confirm',
              },
            }),
      });
      return renderKeyHintRow(tuiTheme().ui, set.hints, width, set.right);
    }),
  });
}

// The editor completes the registry's `/`-commands as they are
// typed (Pi's editor owns the popup and the completion keys); the submit
// path still parses and dispatches. One provider for the editor's single
// slot — the slash commands, then the @-file mentions when a file source
// exists. The boot's skill names ride the same command provider as
// per-skill `/skill:<name>` rows, so `/skill:<prefix>` completes.
function wireAutocomplete(core: AppCore): void {
  const { seed } = core;
  const commandProvider = new SlashCommandAutocomplete([
    ...SLASH_COMMANDS,
    ...skillCommandSpecs(seed.skillNames ?? []),
  ]);
  core.editor.setAutocomplete(
    seed.listFiles === undefined
      ? commandProvider
      : new CombinedAutocomplete([
          commandProvider,
          new FileMentionAutocomplete(seed.listFiles),
        ]),
  );
}

function header(core: AppCore, width: number): string {
  const { approvalSurface: surface, seed, session } = core;
  return renderHeader(
    tuiTheme().ui,
    {
      approvalsSkipped: core.status.getState().approvalsSkipped,
      ...session.workspace,
      session: session.title ?? shortSessionId(session.sessionId),
      waiting: surface.isShowing() ? 1 + surface.queued().length : 0,
      ...(seed.clock === undefined ? {} : { clock: seed.clock() }),
    },
    width,
  );
}

// Pi's editor inside the kit's box (editor-frame.ts).
// An approval takes the slot as a blocking card.
function editorSlot(core: AppCore): Component {
  const { editor, seed } = core;
  return {
    render: (width: number): string[] => {
      const request = core.approvalSurface.pending();
      if (request !== undefined) {
        return renderApprovalCard(
          tuiTheme().ui,
          request,
          width,
          core.approvals.cardOptions(),
        );
      }
      const inner = width - EDITOR_FRAME_CELLS;
      return frameEditorLines(
        tuiTheme().ui,
        editor.render(inner >= 1 ? inner : Math.max(1, width)),
        width,
        {
          busy: core.turn.busy,
          empty: editor.getText() === '',
          hint: seed.listFiles === undefined ? '/ cmd' : '@ file  / cmd',
          placeholder: QUEUE_PLACEHOLDER,
        },
      );
    },
    invalidate: (): void => {
      editor.invalidate();
    },
  };
}

// What the key-hint row follows: the modal that owns the keys, else the
// turn.
function hintContext(core: AppCore): HintContext {
  if (core.approvals.cardVisible()) {
    return core.approvalSurface.inputMode() === undefined
      ? 'approval'
      : 'approvalInput';
  }
  if (core.palette.current !== undefined) return 'palette';
  if (core.blocks.viewer !== undefined) return 'overlay';
  if (core.blocks.selected !== undefined) return 'blocks';
  if (core.overlays.confirm !== undefined) return 'confirm';
  if (core.overlays.picker?.kind === 'model') return 'model';
  if (core.overlays.picker !== undefined) return 'overlay';
  if (core.panel.isOpen()) return 'panel';
  return core.turn.busy ? 'working' : 'idle';
}

// A single-line component over a render function.
function lineComponent(render: (width: number) => string): Component {
  return {
    render: (width: number): string[] => [render(width)],
    invalidate: (): void => {},
  };
}
