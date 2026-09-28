// Alt-screen lifecycle (issue #22, slice B; §16.1).
// Thin over TuiAltScreen: boot sets the layout root, render draws one
// frame, stop restores the main screen and THEN prints the final document
// through the caller's printer (stdout in prod, capture in tests).

import type { Terminal, VStack } from './tui-boundary.js';
import { TuiAltScreen } from './tui-boundary.js';

export interface Screen {
  render: () => void;
  // Differential frame (only changed rows are written), coalesced to one
  // per tick. For high-frequency repaints — the spinner, mid-turn
  // transcript refreshes — where a forced full clear on every frame would
  // flicker on terminals without synchronized output.
  update: () => void;
  stop: (print: (line: string) => void) => void;
  // Issue #313: the last-resort restore (a signal or an exception): leave
  // the alt screen and restore every terminal mode, printing nothing — the
  // layout may be what threw. Idempotent with stop: whichever runs first
  // restores, the other is a no-op, so the terminal is stopped exactly once.
  restore: () => void;
  // The live alt-screen (issue #75): the composition root needs
  // setFocus/addInputListener to route keyboard input. Additive — the
  // boot/render/stop lifecycle above is unchanged.
  tui: TuiAltScreen;
}

export function bootScreen(terminal: Terminal, root: VStack): Screen {
  const screen = new TuiAltScreen(terminal);
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
      // Issue #314 (§16.1): the document is rendered while the layout is
      // still attached, but PRINTED only after the terminal left the
      // alternate buffer (and autowrap is back on) — printing first put it
      // in the buffer `?1049l` discards, so the main screen never showed it.
      // preserveScreen: Pi's own reprint is skipped; the caller's printer
      // is the one channel the document takes.
      const document = root.render(terminal.columns);
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
