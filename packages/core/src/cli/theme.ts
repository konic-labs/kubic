// CLI colour palette for the non-TUI commands. Built on the shared design
// tokens (packages/core/src/ui) so `kubic doctor` and the
// TUI read as one product: the same roles, palette and colour-depth rule.
//
// Colour is decided ONCE from the environment and the target stream
// (`detectColorLevel`), so tests are deterministic and `--json` / pipes stay
// byte-clean: at depth `none` every style is the identity.

import { type ColorLevel, detectColorLevel } from '../ui/color.js';
import { createUiTheme, type Style, type UiTheme } from '../ui/style.js';
import { DARK_PALETTE, type Palette } from '../ui/tokens.js';

export type { ColorLevel } from '../ui/color.js';
export { detectColorLevel } from '../ui/color.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface CliTheme {
  readonly level: ColorLevel;
  readonly enabled: boolean;
  /** The token theme new output styles through (roles, surfaces). */
  readonly ui: UiTheme;
  // Konic red: headings, the brand accent.
  readonly accent: Style;
  readonly success: Style;
  readonly warning: Style;
  readonly error: Style;
  // Secondary text: hints, ids, durations.
  readonly muted: Style;
  readonly bold: Style;
  readonly dim: Style;
  // Inline code / command names.
  readonly code: Style;
}

// The palette is the design's dark brand unless one is named
// (the CLI render matrix runs every palette).
export function createCliTheme(
  level: ColorLevel,
  palette: Palette = DARK_PALETTE,
  name = palette === DARK_PALETTE ? 'dark' : 'custom',
): CliTheme {
  const ui = createUiTheme(palette, level, name);
  return {
    level,
    enabled: ui.enabled,
    ui,
    accent: ui.fg('accent'),
    success: ui.fg('ok'),
    warning: ui.fg('warn'),
    error: ui.style({ fg: 'err', bold: true }),
    muted: ui.fg('fg2'),
    bold: ui.style({ bold: true }),
    dim: ui.style({ dim: true }),
    code: ui.fg('fg0'),
  };
}

// The theme for a real stream: `createCliTheme(detectColorLevel(env, tty))`.
export function themeFor(
  stream: { readonly isTTY?: boolean },
  env: Env = process.env,
): CliTheme {
  return createCliTheme(detectColorLevel(env, stream.isTTY === true));
}
