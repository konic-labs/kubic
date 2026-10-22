// Copying text to the system clipboard with OSC 52, and saying on the notice
// row what happened: the size copied, that the text is too large, or that the
// terminal does not take clipboard writes.
import { CLIPBOARD_MAX_BYTES, copySize, formatSize } from '../ui/clipboard.js';
import type { AppCore } from './core.js';

export function copyWithNotice(core: AppCore, text: string | undefined): void {
  const { noticeRow, seed } = core;
  if (text === undefined || text.trim() === '') {
    noticeRow.setFooter('copy: nothing to copy here');
  } else if (copySize(text) > CLIPBOARD_MAX_BYTES) {
    noticeRow.setFooter('too large to copy — ⏎ view and select');
  } else if (seed.clipboard === undefined || !seed.clipboard(text)) {
    noticeRow.setFooter(
      'copy: this terminal does not take clipboard writes (OSC 52)',
    );
  } else {
    noticeRow.setFooter(`copied ${formatSize(copySize(text))}`);
  }
  core.requestRender();
}
