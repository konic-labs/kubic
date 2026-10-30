// Alt-screen lifecycle.
// Thin over TuiAltScreen: boot sets the layout root, render draws one
// frame, stop restores the main screen and THEN prints the final document
// through the caller's printer (stdout in prod, capture in tests).

import type { Terminal, VStack } from './tui-boundary.js';
import {
  CURSOR_MARKER,
  renderFakeCursor,
  TuiAltScreen,
} from './tui-boundary.js';

// The fake cursor: the cell the editor draws as its cursor (the grapheme the
// cursor sits on, or a space at the end of the draft) between two zero-width
// APC markers, which Pi's renderer turns into inverse video. The markers are
// read off Pi's own renderFakeCursor.
const CELL = '\u0000';
const [FAKE_CURSOR_START = '', FAKE_CURSOR_END = ''] =
  renderFakeCursor(CELL).split(CELL);

// The final document is the layout's own render, so it still carries the
// focused editor's cursor: CURSOR_MARKER and the fake cursor's markers, APC
// sequences a plain terminal or log shows as garbage. Pi's own stop path
// strips the hardware marker before it prints; this path prints on the
// caller's channel, so it strips every marker — keeping the grapheme
// underneath. Inverse text in a line is content and stays.
/** @internal */
export function stripCursor(line: string): string {
  return line
    .replaceAll(CURSOR_MARKER, '')
    .replaceAll(FAKE_CURSOR_START, '')
    .replaceAll(FAKE_CURSOR_END, '');
}

// The live alt-screen with a filter over the base frame, run
// BEFORE the overlays are composited on it — the dimmed background behind
// the palette and the pickers never touches the overlay itself.
class KubicAltScreen extends TuiAltScreen {
  baseFilter: ((lines: string[]) => string[]) | undefined;

  protected override compositeOverlays(
    lines: string[],
    termWidth: number,
    termHeight: number,
  ): string[] {
    const filter = this.baseFilter;
    return super.compositeOverlays(
      filter === undefined ? lines : filter(lines),
      termWidth,
      termHeight,
    );
  }
}

export interface Screen {
  render: () => void;
  // Differential frame (only changed rows are written), coalesced to one
  // per tick. For high-frequency repaints — the spinner, mid-turn
  // transcript refreshes — where a forced full clear on every frame would
  // flicker on terminals without synchronized output.
  update: () => void;
  stop: (print: (line: string) => void) => void;
  // The last-resort restore (a signal or an exception): leave
  // the alt screen and restore every terminal mode, printing nothing — the
  // layout may be what threw. Idempotent with stop: whichever runs first
  // restores, the other is a no-op, so the terminal is stopped exactly once.
  restore: () => void;
  // The live alt-screen: the composition root needs
  // setFocus/addInputListener to route keyboard input. Additive — the
  // boot/render/stop lifecycle above is unchanged.
  tui: KubicAltScreen;
}

export function bootScreen(terminal: Terminal, root: VStack): Screen {
  const screen = new KubicAltScreen(terminal);
  screen.setLayoutRoot(root);
  try {
    screen.start();
  } catch (error) {
    // start() can throw after the terminal went active (alt-screen
    // entered) — restore it best-effort so a mid-boot failure never
    // strands the caller's terminal. The original error stands.
    try {
      screen.stop();
    } catch {
      // Restore failures never mask the start error.
    }
    throw error;
  }
  let stopped = false;
  return {
    tui: screen,
    render: () => screen.renderNow(true),
    update: () => screen.requestRender(),
    stop: (print: (line: string) => void) => {
      if (stopped) return;
      stopped = true;
      // The document is rendered while the layout is
      // still attached, but PRINTED only after the terminal left the
      // alternate buffer (and autowrap is back on) — printing first put it
      // in the buffer `?1049l` discards, so the main screen never showed it.
      // preserveScreen: Pi's own reprint is skipped; the caller's printer
      // is the one channel the document takes.
      const document = root.render(terminal.columns).map(stripCursor);
      screen.setLayoutRoot(undefined);
      screen.stop({ preserveScreen: true });
      for (const line of document) print(line);
    },
    restore: () => {
      if (stopped) return;
      stopped = true;
      screen.setLayoutRoot(undefined);
      screen.stop({ preserveScreen: true });
    },
  };
}
