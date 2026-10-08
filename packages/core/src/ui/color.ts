// Colour depth and colour arithmetic for every Kubic terminal surface. The TUI
// (packages/tui) and the CLI helpers (core/src/cli) both style through
// `style.ts`; this module owns the one copy of the depth rule and the downgrade
// maths they share.

export type ColorLevel = 'none' | '16' | '256' | 'truecolor';

export type Rgb = readonly [number, number, number];

type Env = Readonly<Record<string, string | undefined>>;

// Colour depth from the environment. NO_COLOR (any non-empty value) wins;
// FORCE_COLOR=0/false disables and 1/2/3/true/'' force a depth even off a TTY;
// a non-TTY (pipe, file, CI log) or TERM=dumb gets none;
// COLORTERM=truecolor|24bit gets truecolor; *256color / *-direct gets 256;
// anything else gets the 16-colour set.
export function detectColorLevel(env: Env, isTTY: boolean): ColorLevel {
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

export function parseHex(hex: string): Rgb {
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

function distanceSquared(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function nearestXterm256(rgb: Rgb): number {
  const [r, g, b] = rgb;
  const cubeRgb: Rgb = [
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
  return distanceSquared(cubeRgb, rgb) <=
    distanceSquared([grayValue, grayValue, grayValue], rgb)
    ? cube
    : 232 + grayIndex;
}

// The 16 ANSI colours as xterm RGB (the values terminals actually draw),
// indexed 0..15 (0..7 normal, 8..15 bright).
const ANSI16_RGB: readonly Rgb[] = [
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

/** The nearest ANSI colour as a palette index 0..15. */
export function nearestAnsi16Index(rgb: Rgb): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ANSI16_RGB.forEach((candidate, index) => {
    const distance = distanceSquared(candidate, rgb);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** The nearest ANSI foreground SGR code (30..37 normal, 90..97 bright). */
export function nearestAnsi16(rgb: Rgb): number {
  return ansiForeground(nearestAnsi16Index(rgb));
}

/** SGR foreground code for an ANSI palette index 0..15. */
export function ansiForeground(index: number): number {
  return index < 8 ? 30 + index : 90 + (index - 8);
}

/** SGR background code for an ANSI palette index 0..15. */
export function ansiBackground(index: number): number {
  return ansiForeground(index) + 10;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour. */
function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
