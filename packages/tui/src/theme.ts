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
