// The session tree (`/tree`) in the editor's slot. While it is open it owns
// every key (the input router's `session-tree` route) and the slot shows it in
// place of the editor, as pi shows its tree. Enter, Esc and a saved label
// hand their answer to the composition root, which owns what they do.
import { SessionTreeView } from '../session-tree-view.js';
import { copyWithNotice } from './copy.js';
import type { AppCore } from './core.js';
import type { TuiSessionTreeOptions } from './types.js';

// The list takes half the terminal's rows, at least this many.
const MIN_ROWS = 5;

export class SessionTreeController {
  private readonly core: AppCore;
  view: SessionTreeView | undefined;

  constructor(core: AppCore) {
    this.core = core;
  }

  open(options: TuiSessionTreeOptions): void {
    const rows = this.core.overlayHost?.terminal?.rows ?? 30;
    this.view = new SessionTreeView({
      entries: options.entries,
      currentId: options.currentId,
      maxVisible: Math.max(MIN_ROWS, Math.floor(rows / 2)),
      keys: this.core.keys,
      ...(options.selectedId === undefined
        ? {}
        : { selectedId: options.selectedId }),
      onSelect: (entry) => {
        this.close();
        options.onSelect(entry);
      },
      onCancel: () => {
        this.close();
        options.onCancel?.();
      },
      onCopy: (text) => copyWithNotice(this.core, text),
      onLabel: (id, label) => options.onLabel?.(id, label),
    });
    this.core.requestRender();
  }

  handleKey(data: string, keyId: string | undefined): void {
    this.view?.handleKey(data, keyId);
    this.core.requestRender();
  }

  close(): void {
    this.view = undefined;
    this.core.requestRender();
  }
}
