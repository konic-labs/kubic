// Block mode — Esc on an idle, empty editor walks the transcript by blocks
// (prompt, answer, thinking, tool card, receipt): `↑↓`/`k j` move, `g`/`G`
// the ends, `y` copies the block, `Y` its command, `⏎` opens it whole in the
// viewer, `x` expands just it; `i`, `esc` or any other key returns to typing
// (a printable key is typed).
import type { ApprovalOverlayHandle } from '../approval-view.js';
import { BlockViewer } from '../block-viewer.js';
import type { KeyAction } from '../keybindings.js';
import { copyWithNotice } from './copy.js';
import type { AppCore } from './core.js';
import type { TuiInputResult } from './types.js';

interface OpenViewer {
  readonly view: BlockViewer;
  readonly handle: ApprovalOverlayHandle;
}

export class BlockMode {
  private readonly core: AppCore;
  // The selected block while block mode is on.
  selected: string | undefined;
  viewer: OpenViewer | undefined;

  constructor(core: AppCore) {
    this.core = core;
  }

  // The last block, selected; false when the transcript has none.
  enter(): boolean {
    const last = this.core.transcript.blocks().at(-1);
    if (last === undefined) return false;
    this.select(last.id);
    return true;
  }

  exit(): void {
    if (this.selected === undefined) return;
    this.selected = undefined;
    this.core.transcript.select(undefined);
    this.core.transcript.rePin();
    this.core.requestRender();
  }

  // A key in block mode. Undefined for a key it does not take: block mode
  // has ended, and the key is handled as usual.
  handleKey(
    data: string,
    keyId: string | undefined,
    action: KeyAction | undefined,
  ): TuiInputResult | undefined {
    const { transcript } = this.core;
    const blocks = transcript.blocks();
    const at = blocks.findIndex((block) => block.id === this.selected);
    const go = (index: number): void => {
      const target = blocks[Math.max(0, Math.min(blocks.length - 1, index))];
      if (target !== undefined) this.select(target.id);
    };
    const done = { quit: false, consumed: true, cancel: false };
    if (action === 'app.cancel' || data === 'i') {
      this.exit();
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
      this.copyBlock(data === 'Y');
      return done;
    }
    if (keyId === 'enter') {
      this.openSelected();
      return done;
    }
    if (data === 'x') {
      transcript.toggleBlock(this.selected as string);
      this.core.requestRender();
      return done;
    }
    this.exit();
    return undefined;
  }

  closeViewer(): void {
    const open = this.viewer;
    this.viewer = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: this.core.editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    this.core.requestRender();
  }

  private select(id: string): void {
    this.selected = id;
    this.core.transcript.select(id);
    this.core.transcript.reveal(id);
    this.core.requestRender();
  }

  private selectedBlock() {
    return this.core.transcript
      .blocks()
      .find((block) => block.id === this.selected);
  }

  private copyBlock(meta: boolean): void {
    const block = this.selectedBlock();
    if (block === undefined) return;
    this.copyText(meta ? block.metaText : block.copyText);
  }

  private copyText(text: string): void {
    copyWithNotice(this.core, text);
  }

  // The selected block, whole, in the framed viewer.
  private openSelected(): boolean {
    const block = this.selectedBlock();
    if (block === undefined) return false;
    const host = this.core.overlayHost;
    if (host === undefined) return false;
    this.closeViewer();
    const view = new BlockViewer({
      title: blockTitle(block.kind, block.metaText),
      lines: (width) => this.core.transcript.blockLines(block.id, width),
      maxRows: () =>
        Math.max(6, Math.floor(((host.terminal?.rows ?? 30) * 90) / 100)),
      onCopy: () => this.copyBlock(false),
      onClose: () => this.closeViewer(),
    });
    this.viewer = {
      view,
      handle: host.showOverlay(view, {
        width: '90%',
        maxHeight: '90%',
        anchor: 'center',
      }),
    };
    host.requestRender?.();
    return true;
  }
}

function blockTitle(kind: string, meta: string): string {
  switch (kind) {
    case 'tool':
      return meta;
    case 'prose':
      return 'answer';
    default:
      return kind;
  }
}
