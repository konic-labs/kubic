// The idle double-press quit. The notice row says so for the window and
// clears itself when it lapses (a render is requested — no key arrives to
// cause one).
import type { AppCore } from './core.js';

// An idle, empty Ctrl-C arms the quit for this long; a second
// press inside the window quits.
/** @internal */
export const QUIT_ARM_MS = 2000;

export class QuitArming {
  private readonly core: AppCore;
  private armedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private text = '';

  constructor(core: AppCore) {
    this.core = core;
  }

  armed(): boolean {
    return Date.now() < this.armedUntil;
  }

  arm(key: string): void {
    this.disarm();
    this.armedUntil = Date.now() + QUIT_ARM_MS;
    this.text = `press ${key} again to quit`;
    this.core.noticeRow.setFooter(this.text);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.armedUntil = 0;
      if (this.core.noticeRow.footerText() !== this.text) return;
      this.core.noticeRow.setFooter('');
      this.core.requestRender();
    }, QUIT_ARM_MS);
    this.timer.unref?.();
  }

  disarm(): void {
    this.armedUntil = 0;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
