// The transient notice row above the editor.

import type { WorkingInfo } from '../editor-frame.js';
import { renderWorkingLine } from '../editor-frame.js';
import { sanitizeLaneText } from '../lane-text.js';
import { tuiTheme } from '../theme.js';
import type { Component } from '../tui-boundary.js';
import { truncateToWidth } from '../tui-boundary.js';
import { wrapStyled } from '../ui/line.js';

// The editor footer wraps to at most this many rows.
const FOOTER_MAX_ROWS = 2;

// The footer line for a lane's transient
// activity, or undefined when there is none. The 1.0 harness reports the
// attempt and the error (no maxAttempts, no notBefore — the contract), so
// that is what the line names; a retry outranks a compaction.
export function laneActivityLine(lane: {
  readonly retrying?: { readonly attempt: number; readonly error?: string };
  readonly compacting: boolean;
}): string | undefined {
  if (lane.retrying !== undefined) {
    const error = lane.retrying.error;
    return `⟳ retrying · attempt ${lane.retrying.attempt}${error === undefined || error === '' ? '' : ` — ${error}`}`;
  }
  return lane.compacting ? '⟳ compacting context…' : undefined;
}

// The transient notice row above the editor. It shows, in
// order of precedence: the lane's activity (a retry, a compaction), an
// explicit footer (a turn outcome, a command's reply, an error), the working
// line while a turn runs — else nothing, and the row takes no space.
export class NoticeRow implements Component {
  // The working line's facts — the keys that act, this turn's
  // tokens and tool calls.
  private readonly working: () => Omit<WorkingInfo, 'elapsedMs'>;
  private footer = '';
  // The lane's transient activity (a retry backoff, a
  // compaction). It outranks every other notice while it lasts — it is the
  // reason the turn looks idle — and clears the moment the state does.
  private activity = '';
  busySince: number | undefined;

  constructor(working: () => Omit<WorkingInfo, 'elapsedMs'>) {
    this.working = working;
    this.busySince = undefined;
  }

  setFooter(text: string): void {
    this.footer = sanitizeLaneText(text);
  }

  footerText(): string {
    return this.footer;
  }

  setActivity(text: string | undefined): void {
    this.activity = text === undefined ? '' : sanitizeLaneText(text);
  }

  render(width: number): string[] {
    const theme = tuiTheme();
    const w = Math.max(0, width);
    // One cell of indent lines the text up with the editor box below.
    if (this.activity !== '') {
      return [truncateToWidth(` ${theme.warning(this.activity)}`, w, '…')];
    }
    if (this.footer !== '') {
      const styled = this.footer.startsWith('error')
        ? theme.error(this.footer)
        : theme.muted(this.footer);
      // Wrapped, not cut: an error report is the text an operator most
      // needs whole. Capped at two rows.
      const wrapped = wrapStyled(styled, Math.max(1, width - 1));
      const shown = wrapped.slice(0, FOOTER_MAX_ROWS);
      if (wrapped.length > FOOTER_MAX_ROWS) {
        const last = shown.length - 1;
        shown[last] = truncateToWidth(`${shown[last] ?? ''} …`, w - 1, '…');
      }
      return shown.map((line) => truncateToWidth(` ${line}`, w, '…'));
    }
    if (this.busySince !== undefined) {
      return [
        renderWorkingLine(
          theme.ui,
          { ...this.working(), elapsedMs: Date.now() - this.busySince },
          width,
        ),
      ];
    }
    return [];
  }

  invalidate(): void {}
}
