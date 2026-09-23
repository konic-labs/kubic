// Alt-screen lifecycle (issue #22, slice B; §16.1).
// Thin over TuiAltScreen: boot sets the layout root, render draws one
// frame, stop restores the main screen and prints the final document
// through the caller's printer (stdout in prod, capture in tests).

import type { Terminal, VStack } from './tui-boundary.js';
import { TuiAltScreen } from './tui-boundary.js';

export interface Screen {
  render: () => void;
  stop: (print: (line: string) => void) => void;
}

export function bootScreen(terminal: Terminal, root: VStack): Screen {
  const screen = new TuiAltScreen(terminal);
  screen.setLayoutRoot(root);
  screen.start();
  return {
    render: () => screen.renderNow(true),
    stop: (print: (line: string) => void) => {
      for (const line of root.render(terminal.columns)) print(line);
      screen.setLayoutRoot(undefined);
      screen.stop();
    },
  };
}
