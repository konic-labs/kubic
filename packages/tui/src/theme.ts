// Konic terminal palette + wordmark (TUI polish).
// The brand (konic-website-v2 globals.css) is a hot red on near-black with
// square corners and a monospace display face: konic-red #ff004d, ember
// #ff2a1f, amber #ff7a2e, sunset #ff9433, crimson #d1003a, gray #808080,
// eggshell #f4f4f4. The terminal palette maps those onto truecolor, with
// 256-colour and 16-colour fallbacks, and NO_COLOR (https://no-color.org)
// turns every style into the identity.
//
// The ACTIVE theme defaults to 'none' (identity styles): the pure render
// functions stay byte-stable for every existing snapshot, and only the
// composition root opts into colour after checking the real terminal
// (`setTuiTheme(createTuiTheme(detectColorLevel(env, isTTY)))`).

export type ColorLevel = 'none' | '16' | '256' | 'truecolor';

type Style = (text: string) => string;

export interface TuiTheme {
  readonly level: ColorLevel;
  // Konic red: the brand accent (wordmark, prompt bar, editor border).
  readonly accent: Style;
  readonly accentBold: Style;
  // Amber: in-flight work (running tool, spinner).
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
  // The user's prompt line: eggshell text.
  readonly prompt: Style;
}

const ESC = String.fromCharCode(27);

type Rgb = readonly [number, number, number];

// Brand colours with their nearest xterm-256 and ANSI-16 foregrounds.
const PALETTE = {
  red: { rgb: [255, 0, 77], c256: 197, c16: 91 },
  amber: { rgb: [255, 122, 46], c256: 208, c16: 33 },
  green: { rgb: [94, 214, 140], c256: 78, c16: 32 },
  ember: { rgb: [255, 42, 31], c256: 196, c16: 31 },
  sunset: { rgb: [255, 148, 51], c256: 215, c16: 93 },
  gray: { rgb: [128, 128, 128], c256: 244, c16: 90 },
  eggshell: { rgb: [244, 244, 244], c256: 255, c16: 97 },
} as const satisfies Record<string, { rgb: Rgb; c256: number; c16: number }>;

type PaletteKey = keyof typeof PALETTE;

function sgr(open: string, close: string): Style {
  return (text: string): string =>
    text === '' ? '' : `${ESC}[${open}m${text}${ESC}[${close}m`;
}

function fg(level: ColorLevel, key: PaletteKey): string {
  const entry = PALETTE[key];
  if (level === 'truecolor') return `38;2;${entry.rgb.join(';')}`;
  if (level === '256') return `38;5;${entry.c256}`;
  return String(entry.c16);
}

// --- Issue #304: JSON themes (§16.9 "Themes are JSON with a schema") ---
//
// A theme file names the seven colours Kubic styles with; the structure
// (bold accent, dim, italic, …) stays Kubic's. Colours are #rrggbb hex and
// are downgraded to the terminal's colour level exactly like the built-in
// palette: truecolor emits the RGB triple, 256 the nearest xterm-256 entry,
// 16 the nearest ANSI colour, and NO_COLOR/none the identity.

export const THEME_COLOR_KEYS = [
  'accent',
  'warm',
  'success',
  'error',
  'warning',
  'muted',
  'prompt',
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** The seven colours of a theme, each `#rrggbb`. */
export type ThemeColors = Readonly<Record<ThemeColorKey, string>>;

// The shipped built-ins: `default` and `dark` are the Konic brand palette
// (dark-on-near-black), `light` is the light-background variant.
export const THEME_BUILTINS = ['default', 'dark', 'light'] as const;
export type ThemeBuiltin = (typeof THEME_BUILTINS)[number];

/** A named theme rejection: a bad file, a bad key or a bad colour. */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The one parser for a theme file's text. Strict on purpose (§16.9's schema):
// an unknown key or a missing colour is refused by name rather than silently
// dropped, so a typo cannot leave the operator staring at the default theme
// wondering whether the file was read at all.
export function parseThemeJson(text: string, source: string): ThemeColors {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // V8's message quotes a window of the INPUT, so the parser's own text
    // never reaches the error (issue #304 review): a theme path pointed at a
    // credentials file would otherwise print part of it into the boot error,
    // and the config layer keeps secrets out of output everywhere else. The
    // position is enough to find the typo.
    const detail = error instanceof Error ? error.message : '';
    // The line/column form is preferred when V8 gives one (it also prints a
    // bare `position N`, which is the same place in another notation).
    const position =
      /line \d+ column \d+/.exec(detail)?.[0] ??
      /position \d+/.exec(detail)?.[0];
    throw new ThemeError(
      `theme '${source}': invalid JSON${position === undefined ? '' : ` (${position})`}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ThemeError(`theme '${source}': must be a JSON object`);
  }
  const unknown = Object.keys(parsed).filter(
    (key) => key !== 'name' && key !== 'colors',
  );
  if (unknown.length > 0) {
    throw new ThemeError(
      `theme '${source}': unknown key '${unknown[0]}' (expected name, colors)`,
    );
  }
  const colors = parsed.colors;
  if (!isRecord(colors)) {
    throw new ThemeError(`theme '${source}': 'colors' must be an object`);
  }
  const extra = Object.keys(colors).filter(
    (key) => !(THEME_COLOR_KEYS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new ThemeError(
      `theme '${source}': unknown colour '${extra[0]}' ` +
        `(expected ${THEME_COLOR_KEYS.join(', ')})`,
    );
  }
  const out: Partial<Record<ThemeColorKey, string>> = {};
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key];
    if (value === undefined) {
      throw new ThemeError(`theme '${source}': missing colour '${key}'`);
    }
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
      throw new ThemeError(
        `theme '${source}': '${key}' must be a #rrggbb colour ` +
          `(got ${JSON.stringify(value)})`,
      );
    }
    out[key] = value;
  }
  return out as ThemeColors;
}

// The built-in palettes as hex. `default`/`dark` carry the same numbers the
// shipped `createTuiTheme` hand-picked (so its bytes never move); `light`
// is the light-background counterpart.
const BRAND_HEX: ThemeColors = {
  accent: '#ff004d',
  warm: '#ff7a2e',
  success: '#5ed68c',
  error: '#ff2a1f',
  warning: '#ff9433',
  muted: '#808080',
  prompt: '#f4f4f4',
};

const LIGHT_HEX: ThemeColors = {
  accent: '#c40038',
  warm: '#b45309',
  success: '#15803d',
  error: '#b91c1c',
  warning: '#b45309',
  muted: '#52525b',
  prompt: '#18181b',
};

export function builtinThemeColors(name: ThemeBuiltin): ThemeColors {
  return name === 'light' ? LIGHT_HEX : BRAND_HEX;
}

function parseHex(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

// The xterm-256 palette: a 6x6x6 colour cube (16..231) plus a 24-step
// grayscale ramp (232..255). Both candidates are scored and the closer one
// wins, so a neutral grey lands on the ramp instead of a cube corner.
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeIndex(value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  CUBE_LEVELS.forEach((level, index) => {
    const distance = Math.abs(level - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export function nearestXterm256(
  rgb: readonly [number, number, number],
): number {
  const [r, g, b] = rgb;
  const cubeRgb: readonly [number, number, number] = [
    CUBE_LEVELS[nearestCubeIndex(r)] as number,
    CUBE_LEVELS[nearestCubeIndex(g)] as number,
    CUBE_LEVELS[nearestCubeIndex(b)] as number,
  ];
  const cube =
    16 +
    36 * nearestCubeIndex(r) +
    6 * nearestCubeIndex(g) +
    nearestCubeIndex(b);
  const grayIndex = Math.min(
    23,
    Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)),
  );
  const grayValue = 8 + grayIndex * 10;
  const distance = (candidate: readonly [number, number, number]): number =>
    (candidate[0] - r) ** 2 + (candidate[1] - g) ** 2 + (candidate[2] - b) ** 2;
  return distance(cubeRgb) <= distance([grayValue, grayValue, grayValue])
    ? cube
    : 232 + grayIndex;
}

// The 16 ANSI foregrounds as xterm RGB (the values terminals actually draw),
// indexed by their SGR code minus 30 (30..37 normal, 90..97 bright).
const ANSI16_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

export function nearestAnsi16(rgb: readonly [number, number, number]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ANSI16_RGB.forEach((candidate, index) => {
    const distance =
      (candidate[0] - rgb[0]) ** 2 +
      (candidate[1] - rgb[1]) ** 2 +
      (candidate[2] - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best < 8 ? 30 + best : 90 + (best - 8);
}

function hexFg(level: ColorLevel, hex: string): string {
  const rgb = parseHex(hex);
  if (level === 'truecolor') return `38;2;${rgb.join(';')}`;
  if (level === '256') return `38;5;${nearestXterm256(rgb)}`;
  return String(nearestAnsi16(rgb));
}

// A theme from an arbitrary palette. The structure is exactly the shipped
// one: only the colours move, so a custom theme cannot lose the styling
// contract the views read.
export function createThemeFromColors(
  colors: ThemeColors,
  level: ColorLevel,
): TuiTheme {
  if (level === 'none') return createTuiTheme('none');
  const color = (hex: string): Style => sgr(hexFg(level, hex), '39');
  return {
    level,
    accent: color(colors.accent),
    accentBold: sgr(`1;${hexFg(level, colors.accent)}`, '22;39'),
    warm: color(colors.warm),
    success: color(colors.success),
    error: color(colors.error),
    warning: sgr(`1;${hexFg(level, colors.warning)}`, '22;39'),
    muted: color(colors.muted),
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    italic: sgr('3', '23'),
    underline: sgr('4', '24'),
    strike: sgr('9', '29'),
    code: color(colors.warning),
    prompt: sgr(`1;${hexFg(level, colors.prompt)}`, '22;39'),
  };
}

export function isThemeBuiltin(name: string): name is ThemeBuiltin {
  return (THEME_BUILTINS as readonly string[]).includes(name);
}

const identity: Style = (text: string): string => text;

export function createTuiTheme(level: ColorLevel): TuiTheme {
  if (level === 'none') {
    return {
      level,
      accent: identity,
      accentBold: identity,
      warm: identity,
      success: identity,
      error: identity,
      warning: identity,
      muted: identity,
      dim: identity,
      bold: identity,
      italic: identity,
      underline: identity,
      strike: identity,
      code: identity,
      prompt: identity,
    };
  }
  const color = (key: PaletteKey): Style => sgr(fg(level, key), '39');
  return {
    level,
    accent: color('red'),
    accentBold: sgr(`1;${fg(level, 'red')}`, '22;39'),
    warm: color('amber'),
    success: color('green'),
    error: color('ember'),
    warning: sgr(`1;${fg(level, 'sunset')}`, '22;39'),
    muted: color('gray'),
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    italic: sgr('3', '23'),
    underline: sgr('4', '24'),
    strike: sgr('9', '29'),
    code: color('sunset'),
    prompt: sgr(`1;${fg(level, 'eggshell')}`, '22;39'),
  };
}

// Colour depth from the environment. NO_COLOR (any non-empty value) wins;
// FORCE_COLOR=0 disables and 1/2/3 force a depth; a non-TTY or TERM=dumb
// gets none; COLORTERM=truecolor|24bit gets truecolor; *256color gets 256;
// anything else gets the 16-colour set.
export function detectColorLevel(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return 'none';
  if (force === '3') return 'truecolor';
  if (force === '2') return '256';
  if (force === '1' || force === 'true' || force === '') return '16';
  if (!isTTY) return 'none';
  const term = env.TERM ?? '';
  if (term === 'dumb') return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (term.endsWith('256color') || term.endsWith('-direct')) return '256';
  return '16';
}

let active: TuiTheme = createTuiTheme('none');

export function tuiTheme(): TuiTheme {
  return active;
}

export function setTuiTheme(theme: TuiTheme): void {
  active = theme;
}

// The Kubic wordmark: a square Konic mark (radius 0, like the site) and the
// product name. Kept to one line so the header costs a single row.
export const WORDMARK_GLYPH = '■';
export const WORDMARK_NAME = 'kubic';
export const WORDMARK_TAGLINE = 'by konic';

// Braille spinner frames for the working indicator.
export const SPINNER_FRAMES: readonly string[] = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];

export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / 80) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0] ?? '';
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
