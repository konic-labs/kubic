// The one style engine for Kubic's terminal surfaces (EPIC N, issue #444).
// A `UiTheme` binds a palette (tokens.ts) to a colour depth (color.ts) and
// hands out `Style` functions for semantic roles. At depth `none` every style
// is the identity, so pure render functions stay byte-stable for snapshots,
// pipes and NO_COLOR.
//
// Each style closes only what it opened (39 fg, 49 bg, 22 bold/dim, 23
// italic, 24 underline, 27 inverse, 29 strike), so styles nest. A full-width
// surface uses `reassertBackground` to keep its background through any inner
// reset.

import {
  ansiBackground,
  ansiForeground,
  type ColorLevel,
  isHexColor,
  nearestAnsi16Index,
  nearestXterm256,
  parseHex,
} from './color.js';
import {
  ansiSlot,
  BACKGROUND_ROLES,
  type ColorValue,
  type Palette,
  type TokenRole,
} from './tokens.js';

export type Style = (text: string) => string;

export interface StyleSpec {
  readonly fg?: TokenRole;
  readonly bg?: TokenRole;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strike?: boolean;
}

export interface UiTheme {
  readonly name: string;
  readonly level: ColorLevel;
  /** False at depth `none`: every style is the identity. */
  readonly enabled: boolean;
  readonly palette: Palette;
  style(spec: StyleSpec): Style;
  fg(role: TokenRole): Style;
  bg(role: TokenRole): Style;
  /** The raw opening sequence for a spec ('' when it styles nothing). */
  open(spec: StyleSpec): string;
  /** The raw closing sequence for a spec ('' when it styles nothing). */
  close(spec: StyleSpec): string;
}

const ESC = '\u001b';

function colorParams(
  value: ColorValue,
  layer: 'fg' | 'bg',
  level: ColorLevel,
  role: TokenRole,
): string | undefined {
  if (level === 'none' || value === 'none') return undefined;
  const slot = ansiSlot(value);
  if (slot !== undefined) {
    return String(layer === 'fg' ? ansiForeground(slot) : ansiBackground(slot));
  }
  if (!isHexColor(value)) return undefined;
  const rgb = parseHex(value);
  if (level === 'truecolor') {
    return `${layer === 'fg' ? 38 : 48};2;${rgb.join(';')}`;
  }
  if (level === '256') {
    return `${layer === 'fg' ? 38 : 48};5;${nearestXterm256(rgb)}`;
  }
  // 16 colours: a grey surface reads worse than none, so surfaces drop their
  // background — except the selection, which keeps bright black.
  if (layer === 'bg' && BACKGROUND_ROLES.has(role)) {
    return role === 'bg3' ? String(ansiBackground(8)) : undefined;
  }
  const index = nearestAnsi16Index(rgb);
  return String(layer === 'fg' ? ansiForeground(index) : ansiBackground(index));
}

interface Codes {
  readonly open: string;
  readonly close: string;
}

function codesFor(spec: StyleSpec, palette: Palette, level: ColorLevel): Codes {
  if (level === 'none') return { open: '', close: '' };
  const open: string[] = [];
  const close: string[] = [];
  if (spec.bold === true) open.push('1');
  if (spec.dim === true) open.push('2');
  if (spec.bold === true || spec.dim === true) close.push('22');
  if (spec.italic === true) {
    open.push('3');
    close.push('23');
  }
  if (spec.underline === true) {
    open.push('4');
    close.push('24');
  }
  if (spec.inverse === true) {
    open.push('7');
    close.push('27');
  }
  if (spec.strike === true) {
    open.push('9');
    close.push('29');
  }
  if (spec.fg !== undefined) {
    const params = colorParams(palette[spec.fg], 'fg', level, spec.fg);
    if (params !== undefined) {
      open.push(params);
      close.push('39');
    }
  }
  if (spec.bg !== undefined) {
    const params = colorParams(palette[spec.bg], 'bg', level, spec.bg);
    if (params !== undefined) {
      open.push(params);
      close.push('49');
    }
  }
  if (open.length === 0) return { open: '', close: '' };
  return {
    open: `${ESC}[${open.join(';')}m`,
    close: `${ESC}[${close.join(';')}m`,
  };
}

function specKey(spec: StyleSpec): string {
  return [
    spec.fg ?? '',
    spec.bg ?? '',
    spec.bold === true ? 'b' : '',
    spec.dim === true ? 'd' : '',
    spec.italic === true ? 'i' : '',
    spec.underline === true ? 'u' : '',
    spec.inverse === true ? 'v' : '',
    spec.strike === true ? 's' : '',
  ].join('|');
}

const identity: Style = (text: string): string => text;

export function createUiTheme(
  palette: Palette,
  level: ColorLevel,
  name = 'custom',
): UiTheme {
  const codes = new Map<string, Codes>();
  const styles = new Map<string, Style>();
  const codesOf = (spec: StyleSpec): Codes => {
    const key = specKey(spec);
    let found = codes.get(key);
    if (found === undefined) {
      found = codesFor(spec, palette, level);
      codes.set(key, found);
    }
    return found;
  };
  const style = (spec: StyleSpec): Style => {
    const key = specKey(spec);
    let found = styles.get(key);
    if (found === undefined) {
      const { open, close } = codesOf(spec);
      found =
        open === ''
          ? identity
          : (text: string): string =>
              text === '' ? '' : `${open}${text}${close}`;
      styles.set(key, found);
    }
    return found;
  };
  return {
    name,
    level,
    enabled: level !== 'none',
    palette,
    style,
    fg: (role) => style({ fg: role }),
    bg: (role) => style({ bg: role }),
    open: (spec) => codesOf(spec).open,
    close: (spec) => codesOf(spec).close,
  };
}

// True when an SGR parameter list resets the background: a full reset (0 or
// an empty list) or the default-background code 49. Extended colour
// parameters (38/48/58 with 5;n or 2;r;g;b) are skipped so a palette index
// of 0 is not mistaken for a reset.
function resetsBackground(params: string): boolean {
  if (params === '') return true;
  const parts = params.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '' || part === '0' || part === '49') return true;
    if (part === '38' || part === '48' || part === '58') {
      const mode = parts[index + 1];
      index += mode === '5' ? 2 : mode === '2' ? 4 : 1;
    }
  }
  return false;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const SGR_SEQUENCE = /\u001b\[([0-9;]*)m/g;

/**
 * Re-open a surface background after every inner sequence that would end it,
 * so a full-width surface keeps its colour through nested styles.
 */
export function reassertBackground(
  text: string,
  backgroundOpen: string,
): string {
  if (backgroundOpen === '') return text;
  return text.replace(SGR_SEQUENCE, (sequence: string, params: string) =>
    resetsBackground(params) ? `${sequence}${backgroundOpen}` : sequence,
  );
}

/** Remove every SGR (colour/attribute) sequence, keeping the text. */
export function stripStyles(text: string): string {
  return text.replace(SGR_SEQUENCE, '');
}

// Issue #468: what a rendered line leaves set at its end — each SGR
// attribute still on (`intensity`, `italic`, `underline`, `inverse`,
// `strike`, `fg`, `bg`) and an OSC 8 hyperlink still open. Empty means the
// line closes everything it opens, so nothing bleeds into the next one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching OSC 8 escapes is the point
const HYPERLINK = /\u001b\]8;[^;]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

export function openStyles(line: string): string[] {
  if (!line.includes('\u001b')) return [];
  const on = new Set<string>();
  for (const match of line.matchAll(SGR_SEQUENCE)) {
    const params = (match[1] ?? '').split(';');
    if (params.length === 1 && params[0] === '') params[0] = '0';
    for (let index = 0; index < params.length; index += 1) {
      const code = Number(params[index]);
      if (code === 0) on.clear();
      else if (code === 1 || code === 2) on.add('intensity');
      else if (code === 22) on.delete('intensity');
      else if (code === 3) on.add('italic');
      else if (code === 23) on.delete('italic');
      else if (code === 4) on.add('underline');
      else if (code === 24) on.delete('underline');
      else if (code === 7) on.add('inverse');
      else if (code === 27) on.delete('inverse');
      else if (code === 9) on.add('strike');
      else if (code === 29) on.delete('strike');
      else if (code === 38 || code === 48) {
        on.add(code === 38 ? 'fg' : 'bg');
        index += params[index + 1] === '5' ? 2 : 4;
      } else if (code === 39) on.delete('fg');
      else if (code === 49) on.delete('bg');
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        on.add('fg');
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        on.add('bg');
      }
    }
  }
  let link = false;
  for (const match of line.matchAll(HYPERLINK)) link = (match[1] ?? '') !== '';
  return [...on, ...(link ? ['hyperlink'] : [])];
}
