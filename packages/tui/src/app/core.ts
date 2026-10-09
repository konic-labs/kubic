// The shared state of one TUI app: the views every controller paints into,
// the approval surface, the overlay seat, and the controllers themselves.

import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import {
  type ApprovalSurface,
  createApprovalSurface,
} from '../approval-surface.js';
import type { ApprovalOverlayTui } from '../approval-view.js';
import { keyCap } from '../chrome.js';
import { PromptEditor } from '../editor-view.js';
import { DEFAULT_KEY_REGISTRY, type KeyRegistry } from '../keybindings.js';
import type { StatusBar } from '../status-bar.js';
import { createTranscriptView, type TranscriptView } from '../transcript.js';
import { TreeView } from '../tree.js';
import { fileUrl } from '../ui/file-links.js';
import type { ApprovalsController } from './approvals.js';
import type { BlockMode } from './blocks.js';
import type { NoticeRow } from './notice-row.js';
import type { OverlayController } from './overlays.js';
import type { PaletteController } from './palette-controller.js';
import type { PanelController } from './panel.js';
import type { QuitArming } from './quit.js';
import type { SessionView } from './session-view.js';
import type { TurnView } from './turn-view.js';
import type { TuiAppSeed, TuiSubmitOutcome } from './types.js';

export class AppCore {
  readonly seed: TuiAppSeed;
  readonly keys: KeyRegistry;
  readonly tree: TreeView;
  readonly transcript: TranscriptView;
  readonly editor: PromptEditor;
  // The surface that collects approval verdicts: the composition root's
  // (the seat its lane's policy consults), else a private one — the viewer
  // shell still renders an ask inline instead of hanging.
  readonly approvalSurface: ApprovalSurface;
  // Built with the layout.
  status!: StatusBar;
  noticeRow!: NoticeRow;
  // The live screen's overlay seat, attached at boot.
  overlayHost: ApprovalOverlayTui | undefined;
  // The loop's submit path.
  submitHandler: ((prompt: string) => TuiSubmitOutcome | undefined) | undefined;
  session!: SessionView;
  turn!: TurnView;
  panel!: PanelController;
  quit!: QuitArming;
  overlays!: OverlayController;
  palette!: PaletteController;
  blocks!: BlockMode;
  approvals!: ApprovalsController;

  constructor(seed: TuiAppSeed) {
    this.seed = seed;
    const keys = seed.keys ?? DEFAULT_KEY_REGISTRY;
    this.keys = keys;
    // The tree row starts hidden (collapsed); Ctrl-T opens it.
    this.tree = new TreeView(undefined, {
      label: seed.label ?? DEFAULT_RUN_ROLE,
      collapsed: true,
    });
    const projectFileUrl = projectFileLinker(seed);
    // The transcript row must stay the ScrollView itself so the layout engine
    // sizes it (follow-end only works when the ScrollView is the row).
    this.transcript = createTranscriptView({
      // The cards' duration, running clock and waiting state,
      // and the expand key's real cap.
      toolState: (toolCallId: string) => this.turn.toolStateOf(toolCallId),
      expandKey: () => keyCap(keys.label('transcript.expand')),
      ...(projectFileUrl === undefined ? {} : { fileUrl: projectFileUrl }),
    });
    this.editor = new PromptEditor();
    this.approvalSurface =
      seed.approvalSurface ??
      createApprovalSurface({ keyOverrides: keys.approvalOverrides() });
  }

  // A frame from the live screen, when one is attached.
  requestRender(): void {
    this.overlayHost?.requestRender?.();
  }
}

// Project paths that exist get a `file://` link. The lister
// is the @-mention one (cached by the composition root); the set is
// rebuilt only when it hands back a new list.
function projectFileLinker(
  seed: TuiAppSeed,
): ((path: string) => string | undefined) | undefined {
  const listFiles = seed.listFiles;
  const fileRoot = seed.fileRoot;
  if (listFiles === undefined || fileRoot === undefined) return undefined;
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
}
