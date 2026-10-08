// Shared vitest setup: the TUI theme is a process-global, so a
// test that leaves a coloured theme active changes what every later test in
// the same worker renders. After each test the theme is reset to 'none'; a
// test that left it coloured fails by name instead of breaking a neighbour.

import { createTuiTheme, setTuiTheme, tuiTheme } from '@kubic/tui/theme';
import { afterEach } from 'vitest';

afterEach(() => {
  const level = tuiTheme().level;
  if (level === 'none') return;
  setTuiTheme(createTuiTheme('none'));
  throw new Error(
    `a test left the TUI theme at colour level '${level}': reset it (or restore the previous theme) before the test ends`,
  );
});
