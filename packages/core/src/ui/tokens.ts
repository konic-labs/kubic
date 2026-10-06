// Kubic colour tokens (EPIC N, issue #444; docs/ui/README.md "Colour tokens").
// One set of semantic roles for every terminal surface. A palette assigns a
// colour value to each role; `style.ts` turns roles into escape sequences for
// the terminal's colour depth.
//
// A colour value is one of:
//   '#rrggbb'  — an exact colour, downgraded to 256/16 colours as needed;
//   'ansi:N'   — the terminal's own palette slot N (0..15), so the user's
//                terminal theme decides the actual colour;
//   'none'     — no colour: the terminal default (no background, default text).
//
// bg0 is the canvas. Surfaces never paint it (the terminal's own background
// shows through); it exists so contrast can be checked against it.

export const TOKEN_ROLES = [
  'bg0',
  'bg1',
  'bg2',
  'bg3',
  'fg0',
  'fg1',
  'fg2',
  'fg3',
  'accent',
  'accentBg',
  'ok',
  'okBg',
  'warn',
  'warnBg',
  'err',
  'errBg',
  'info',
  'add',
  'addBg',
  'del',
  'delBg',
  // Issue #456: the changed words inside an added / removed diff line.
  'addWordBg',
  'delWordBg',
] as const;

export type TokenRole = (typeof TOKEN_ROLES)[number];

export type ColorValue = string;

export type Palette = Readonly<Record<TokenRole, ColorValue>>;

/** Roles that are surfaces (painted as a background, never as text). */
export const BACKGROUND_ROLES: ReadonlySet<TokenRole> = new Set<TokenRole>([
  'bg0',
  'bg1',
  'bg2',
  'bg3',
  'accentBg',
  'okBg',
  'warnBg',
  'errBg',
  'addBg',
  'delBg',
  'addWordBg',
  'delWordBg',
]);

export function isTokenRole(name: string): name is TokenRole {
  return (TOKEN_ROLES as readonly string[]).includes(name);
}

const ANSI_VALUE = /^ansi:(\d{1,2})$/;

/** The palette slot of an `ansi:N` value, or undefined for any other value. */
export function ansiSlot(value: ColorValue): number | undefined {
  const match = ANSI_VALUE.exec(value);
  if (match === null) return undefined;
  const slot = Number(match[1]);
  return slot >= 0 && slot <= 15 ? slot : undefined;
}

// The Konic brand on a near-black terminal (docs/ui values).
export const DARK_PALETTE: Palette = {
  bg0: '#0a0a0c',
  bg1: '#111115',
  bg2: '#18181e',
  bg3: '#22222a',
  fg0: '#ececf1',
  fg1: '#a3a3ae',
  fg2: '#6e6e79',
  fg3: '#3c3c45',
  accent: '#ff004d',
  accentBg: '#2a0612',
  ok: '#5ed68c',
  okBg: '#0c2416',
  warn: '#ffb547',
  warnBg: '#2a1d07',
  err: '#ff6b5e',
  errBg: '#2c0d0b',
  info: '#7fb4ff',
  add: '#7ee2a0',
  addBg: '#0e2617',
  del: '#ff8f9c',
  delBg: '#2d0e15',
  addWordBg: '#164a2a',
  delWordBg: '#4a1220',
};

// The same roles for a light terminal background: dark text on near-white
// surfaces, Konic red deepened so it keeps its contrast on white.
export const LIGHT_PALETTE: Palette = {
  bg0: '#ffffff',
  bg1: '#f3f3f6',
  bg2: '#ebebf0',
  bg3: '#dfdfe7',
  fg0: '#18181b',
  fg1: '#3f3f46',
  fg2: '#63636e',
  fg3: '#a1a1aa',
  accent: '#d0003f',
  accentBg: '#ffe5ec',
  ok: '#15803d',
  okBg: '#e6f6ec',
  warn: '#a35200',
  warnBg: '#fff3df',
  err: '#c0261b',
  errBg: '#fdecea',
  info: '#1d4ed8',
  add: '#166534',
  addBg: '#dcfce7',
  del: '#9f1239',
  delBg: '#ffe4e6',
  addWordBg: '#bbf7d0',
  delWordBg: '#fecdd3',
};

// The terminal's own colours: no backgrounds of its own (translucent or
// image backgrounds show through), semantic roles on the ANSI palette slots
// so the user's terminal theme decides the actual colours. Selection uses
// bright black, the one background most palettes keep readable.
export const TERMINAL_PALETTE: Palette = {
  bg0: 'none',
  bg1: 'none',
  bg2: 'none',
  bg3: 'ansi:8',
  fg0: 'none',
  fg1: 'none',
  fg2: 'ansi:8',
  fg3: 'ansi:8',
  accent: 'ansi:1',
  accentBg: 'none',
  ok: 'ansi:2',
  okBg: 'none',
  warn: 'ansi:3',
  warnBg: 'none',
  err: 'ansi:1',
  errBg: 'none',
  info: 'ansi:4',
  add: 'ansi:2',
  addBg: 'none',
  del: 'ansi:1',
  delBg: 'none',
  addWordBg: 'none',
  delWordBg: 'none',
};

export const PALETTE_BUILTINS = [
  'default',
  'dark',
  'light',
  'terminal',
] as const;

export type PaletteBuiltin = (typeof PALETTE_BUILTINS)[number];

export function isPaletteBuiltin(name: string): name is PaletteBuiltin {
  return (PALETTE_BUILTINS as readonly string[]).includes(name);
}

/** A built-in palette by name; `default` is the dark brand palette. */
export function builtinPalette(name: PaletteBuiltin): Palette {
  if (name === 'light') return LIGHT_PALETTE;
  if (name === 'terminal') return TERMINAL_PALETTE;
  return DARK_PALETTE;
}
