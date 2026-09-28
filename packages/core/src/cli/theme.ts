// CLI colour palette (chalk) for the non-TUI commands. Same Konic brand as
// packages/tui/src/theme.ts — konic red #ff004d, amber #ff7a2e, green
// #5ed68c, gray #808080, eggshell #f4f4f4 — so `kubic doctor` and the TUI
// read as one product. chalk downsamples the hex colours to 256/16 colours
// by level; level 0 makes every style the identity.
//
// Colour is decided ONCE from the environment and the target stream
// (`detectColorLevel`), never from chalk's own global auto-detection, so
// tests are deterministic and `--json` / pipes stay byte-clean.

import { Chalk, type ChalkInstance } from 'chalk';

export type ColorLevel = 'none' | '16' | '256' | 'truecolor';

type Env = Readonly<Record<string, string | undefined>>;

// NO_COLOR (https://no-color.org) wins over everything; FORCE_COLOR forces
// a level even off a TTY; otherwise a non-TTY (pipe, file, CI log) is
// colourless. Mirrors the TUI's detection rule.
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

type Style = (text: string) => string;

export interface CliTheme {
  readonly level: ColorLevel;
  readonly enabled: boolean;
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

const CHALK_LEVEL = { none: 0, '16': 1, '256': 2, truecolor: 3 } as const;

export const KONIC_COLORS = {
  red: '#ff004d',
  amber: '#ff7a2e',
  green: '#5ed68c',
  gray: '#808080',
  eggshell: '#f4f4f4',
} as const;

export function createCliTheme(level: ColorLevel): CliTheme {
  const c: ChalkInstance = new Chalk({ level: CHALK_LEVEL[level] });
  const style =
    (fn: (text: string) => string): Style =>
    (text) =>
      fn(text);
  return {
    level,
    enabled: level !== 'none',
    accent: style(c.hex(KONIC_COLORS.red)),
    success: style(c.hex(KONIC_COLORS.green)),
    warning: style(c.hex(KONIC_COLORS.amber)),
    error: style(c.hex(KONIC_COLORS.red).bold),
    muted: style(c.hex(KONIC_COLORS.gray)),
    bold: style(c.bold),
    dim: style(c.dim),
    code: style(c.hex(KONIC_COLORS.eggshell)),
  };
}

// The theme for a real stream: `createCliTheme(detectColorLevel(env, tty))`.
export function themeFor(
  stream: { readonly isTTY?: boolean },
  env: Env = process.env,
): CliTheme {
  return createCliTheme(detectColorLevel(env, stream.isTTY === true));
}
