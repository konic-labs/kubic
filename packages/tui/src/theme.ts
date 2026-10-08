// Kubic TUI theme (TUI polish; tokens).
// The colours come from the shared design tokens in packages/core/src/ui:
// a palette (dark/default, light, terminal or a JSON theme file) bound to the
// terminal's colour depth. `TuiTheme` keeps the named styles every view
// reads; new views style through `theme.ui` (roles such as fg2, bg2, accent).
//
// The ACTIVE theme defaults to depth 'none' (identity styles): the pure render
// functions stay byte-stable for every existing snapshot, and only the
// composition root opts into colour after checking the real terminal
// (`setTuiTheme(createTuiTheme(detectColorLevel(env, isTTY)))`).

import { type ColorLevel, detectColorLevel } from '../../core/src/ui/color.js';
import { SPINNER_FRAMES, spinnerFrame } from '../../core/src/ui/glyphs.js';
import {
  createUiTheme,
  type Style,
  type UiTheme,
} from '../../core/src/ui/style.js';
import { parseThemeJson, ThemeError } from '../../core/src/ui/theme-file.js';
import {
  builtinPalette,
  isPaletteBuiltin,
  type Palette,
  type PaletteBuiltin,
} from '../../core/src/ui/tokens.js';

export type { ColorLevel };
export {
  detectColorLevel,
  parseThemeJson,
  SPINNER_FRAMES,
  spinnerFrame,
  ThemeError,
};

export interface TuiTheme {
  readonly level: ColorLevel;
  /** The token theme new views style through (roles, surfaces). */
  readonly ui: UiTheme;
  // Konic red: the brand accent (wordmark, prompt bar, editor border).
  readonly accent: Style;
  readonly accentBold: Style;
  // In-flight work (running tool, spinner): the warn role.
  readonly warm: Style;
  readonly success: Style;
  readonly error: Style;
  readonly warning: Style;
  // Secondary text (hints, durations, tool output).
  readonly muted: Style;
  readonly dim: Style;
  readonly bold: Style;
  readonly italic: Style;
  readonly underline: Style;
  readonly strike: Style;
  // Inline code / code block body.
  readonly code: Style;
  // The user's prompt line.
  readonly prompt: Style;
}

export type ThemeBuiltin = PaletteBuiltin;

export function isThemeBuiltin(name: string): name is ThemeBuiltin {
  return isPaletteBuiltin(name);
}

export function builtinThemePalette(name: ThemeBuiltin): Palette {
  return builtinPalette(name);
}

// A TUI theme from any palette. The structure is fixed: only the colours
// move, so a custom theme cannot lose the styling contract the views read.
export function createThemeFromPalette(
  palette: Palette,
  level: ColorLevel,
  name = 'custom',
): TuiTheme {
  const ui = createUiTheme(palette, level, name);
  return {
    level,
    ui,
    accent: ui.fg('accent'),
    accentBold: ui.style({ fg: 'accent', bold: true }),
    warm: ui.fg('warn'),
    success: ui.fg('ok'),
    error: ui.fg('err'),
    warning: ui.style({ fg: 'warn', bold: true }),
    muted: ui.fg('fg2'),
    dim: ui.style({ dim: true }),
    bold: ui.style({ bold: true }),
    italic: ui.style({ italic: true }),
    underline: ui.style({ underline: true }),
    strike: ui.style({ strike: true }),
    code: ui.fg('warn'),
    prompt: ui.style({ fg: 'fg0', bold: true }),
  };
}

/** The default (dark brand) theme at a colour depth. */
export function createTuiTheme(level: ColorLevel): TuiTheme {
  return createThemeFromPalette(builtinPalette('dark'), level, 'dark');
}

let active: TuiTheme = createTuiTheme('none');

export function tuiTheme(): TuiTheme {
  return active;
}

export function setTuiTheme(theme: TuiTheme): void {
  active = theme;
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
