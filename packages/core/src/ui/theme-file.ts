// JSON theme files (`[ui] theme = "<path>"`, v2).
//
// v2 (token roles):
//   { "name"?: string, "extends"?: "default"|"dark"|"light"|"terminal",
//     "colors": { "<role>": "#rrggbb", ... } }
// Any subset of the roles in tokens.ts; the rest come from `extends`
// (default: dark).
//
// v1 (still accepted): exactly the seven keys accent, warm,
// success, error, warning, muted, prompt — mapped onto the dark palette
// (accent→accent, success→ok, error→err, warning→warn, muted→fg2,
// prompt→fg0; warm is accepted and unused).
//
// Strict on purpose: an unknown key or a bad colour is refused by name, so a
// typo cannot leave the operator staring at the default theme. Errors never
// quote the file's text (a theme path pointed at a secret must not leak it).

import { isHexColor } from './color.js';
import {
  builtinPalette,
  DARK_PALETTE,
  isPaletteBuiltin,
  isTokenRole,
  PALETTE_BUILTINS,
  type Palette,
  TOKEN_ROLES,
  type TokenRole,
} from './tokens.js';

/** A named theme rejection: a bad file, a bad key or a bad colour. */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

/** The seven v1 colour keys. */
const LEGACY_THEME_KEYS = [
  'accent',
  'warm',
  'success',
  'error',
  'warning',
  'muted',
  'prompt',
] as const;

const LEGACY_ONLY: ReadonlySet<string> = new Set(
  LEGACY_THEME_KEYS.filter((key) => key !== 'accent'),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // V8's message quotes a window of the INPUT, so only the position is
    // kept.
    const detail = error instanceof Error ? error.message : '';
    const position =
      /line \d+ column \d+/.exec(detail)?.[0] ??
      /position \d+/.exec(detail)?.[0];
    throw new ThemeError(
      `theme '${source}': invalid JSON${position === undefined ? '' : ` (${position})`}`,
    );
  }
}

function hexOf(source: string, key: string, value: unknown): string {
  if (typeof value !== 'string' || !isHexColor(value)) {
    throw new ThemeError(
      `theme '${source}': '${key}' must be a #rrggbb colour ` +
        `(got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function parseLegacy(source: string, colors: Record<string, unknown>): Palette {
  const extra = Object.keys(colors).filter(
    (key) => !(LEGACY_THEME_KEYS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new ThemeError(
      `theme '${source}': unknown colour '${extra[0]}' ` +
        `(a v1 theme uses ${LEGACY_THEME_KEYS.join(', ')})`,
    );
  }
  const values: Partial<Record<(typeof LEGACY_THEME_KEYS)[number], string>> =
    {};
  for (const key of LEGACY_THEME_KEYS) {
    if (colors[key] === undefined) {
      throw new ThemeError(`theme '${source}': missing colour '${key}'`);
    }
    values[key] = hexOf(source, key, colors[key]);
  }
  return {
    ...DARK_PALETTE,
    accent: values.accent as string,
    ok: values.success as string,
    err: values.error as string,
    warn: values.warning as string,
    fg2: values.muted as string,
    fg0: values.prompt as string,
  };
}

/** Parse a theme file's text (v1 or v2) into a full palette. */
export function parseThemeJson(text: string, source: string): Palette {
  const parsed = parseJson(text, source);
  if (!isRecord(parsed)) {
    throw new ThemeError(`theme '${source}': must be a JSON object`);
  }
  const unknown = Object.keys(parsed).filter(
    (key) => key !== 'name' && key !== 'colors' && key !== 'extends',
  );
  if (unknown.length > 0) {
    throw new ThemeError(
      `theme '${source}': unknown key '${unknown[0]}' (expected name, extends, colors)`,
    );
  }
  const colors = parsed.colors;
  if (!isRecord(colors)) {
    throw new ThemeError(`theme '${source}': 'colors' must be an object`);
  }
  const legacy = Object.keys(colors).some((key) => LEGACY_ONLY.has(key));
  if (legacy) {
    if (parsed.extends !== undefined) {
      throw new ThemeError(
        `theme '${source}': 'extends' needs a v2 theme (token roles), not the v1 colour keys`,
      );
    }
    return parseLegacy(source, colors);
  }
  const base = parsed.extends;
  if (
    base !== undefined &&
    (typeof base !== 'string' || !isPaletteBuiltin(base))
  ) {
    throw new ThemeError(
      `theme '${source}': 'extends' must be one of ${PALETTE_BUILTINS.join(', ')}`,
    );
  }
  const extra = Object.keys(colors).filter((key) => !isTokenRole(key));
  if (extra.length > 0) {
    throw new ThemeError(
      `theme '${source}': unknown colour '${extra[0]}' ` +
        `(expected token roles: ${TOKEN_ROLES.join(', ')})`,
    );
  }
  const overrides: Partial<Record<TokenRole, string>> = {};
  for (const [key, value] of Object.entries(colors)) {
    overrides[key as TokenRole] = hexOf(source, key, value);
  }
  return { ...builtinPalette(base ?? 'dark'), ...overrides };
}
