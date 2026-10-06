// Design tokens and the style engine (EPIC N, issue #444).
import { describe, expect, it } from 'vitest';
import {
  ansiBackground,
  ansiForeground,
  contrastRatio,
  detectColorLevel,
  nearestAnsi16,
  nearestXterm256,
  parseHex,
} from './color.js';
import { SPINNER_FRAMES, spinnerFrame } from './glyphs.js';
import {
  createUiTheme,
  reassertBackground,
  stripStyles,
  type UiTheme,
} from './style.js';
import {
  ansiSlot,
  builtinPalette,
  DARK_PALETTE,
  isPaletteBuiltin,
  LIGHT_PALETTE,
  type Palette,
  TERMINAL_PALETTE,
  TOKEN_ROLES,
} from './tokens.js';

const ESC = '\u001b';

describe('colour depth detection', () => {
  const tty = true;
  it('NO_COLOR wins over everything', () => {
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }, tty)).toBe(
      'none',
    );
  });
  it('FORCE_COLOR forces a depth even off a TTY (issue #319)', () => {
    expect(detectColorLevel({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(detectColorLevel({ FORCE_COLOR: '2' }, false)).toBe('256');
    expect(detectColorLevel({ FORCE_COLOR: '1' }, false)).toBe('16');
    expect(detectColorLevel({ FORCE_COLOR: 'true' }, false)).toBe('16');
    expect(detectColorLevel({ FORCE_COLOR: '' }, false)).toBe('16');
    expect(detectColorLevel({ FORCE_COLOR: '0' }, tty)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: 'false' }, tty)).toBe('none');
  });
  it('a pipe or TERM=dumb gets none', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe('none');
    expect(detectColorLevel({ TERM: 'dumb' }, tty)).toBe('none');
  });
  it('reads COLORTERM and TERM on a TTY', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, tty)).toBe('truecolor');
    expect(detectColorLevel({ COLORTERM: '24bit' }, tty)).toBe('truecolor');
    expect(detectColorLevel({ TERM: 'xterm-256color' }, tty)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm-direct' }, tty)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm' }, tty)).toBe('16');
  });
});

describe('colour downgrade maths', () => {
  it('parses hex and finds the nearest xterm-256 and ANSI colours', () => {
    expect(parseHex('#ff004d')).toEqual([255, 0, 77]);
    expect(nearestXterm256([255, 0, 77])).toBe(197);
    expect(nearestXterm256([128, 128, 128])).toBe(244);
    expect(nearestAnsi16([255, 0, 77])).toBe(91);
    expect(nearestAnsi16([0, 0, 0])).toBe(30);
  });
  it('maps ANSI slots to SGR codes', () => {
    expect(ansiForeground(1)).toBe(31);
    expect(ansiForeground(9)).toBe(91);
    expect(ansiBackground(8)).toBe(100);
    expect(ansiSlot('ansi:8')).toBe(8);
    expect(ansiSlot('ansi:16')).toBeUndefined();
    expect(ansiSlot('#ffffff')).toBeUndefined();
  });
});

describe('palettes', () => {
  const palettes: ReadonlyArray<readonly [string, Palette]> = [
    ['dark', DARK_PALETTE],
    ['light', LIGHT_PALETTE],
    ['terminal', TERMINAL_PALETTE],
  ];
  it('every built-in assigns every role', () => {
    for (const [, palette] of palettes) {
      expect(Object.keys(palette).sort()).toEqual([...TOKEN_ROLES].sort());
    }
  });
  it('resolves built-in names; default is dark', () => {
    expect(isPaletteBuiltin('terminal')).toBe(true);
    expect(isPaletteBuiltin('solar')).toBe(false);
    expect(builtinPalette('default')).toBe(DARK_PALETTE);
    expect(builtinPalette('light')).toBe(LIGHT_PALETTE);
  });
  for (const [name, palette] of palettes.slice(0, 2)) {
    it(`${name}: text roles keep their contrast on the canvas`, () => {
      expect(contrastRatio(palette.fg0, palette.bg0)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(palette.fg1, palette.bg0)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(palette.fg2, palette.bg0)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.accent, palette.bg0)).toBeGreaterThanOrEqual(
        3,
      );
      expect(contrastRatio(palette.fg0, palette.bg2)).toBeGreaterThanOrEqual(7);
    });
    it(`${name}: diff colours read on their surfaces`, () => {
      expect(contrastRatio(palette.add, palette.addBg)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(palette.del, palette.delBg)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrastRatio(palette.warn, palette.warnBg),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the style engine', () => {
  const at = (level: 'none' | '16' | '256' | 'truecolor'): UiTheme =>
    createUiTheme(DARK_PALETTE, level, 'dark');

  it('is the identity at depth none', () => {
    const theme = at('none');
    expect(theme.enabled).toBe(false);
    expect(theme.style({ fg: 'accent', bg: 'bg2', bold: true })('x')).toBe('x');
    expect(theme.open({ fg: 'accent' })).toBe('');
    expect(theme.close({ fg: 'accent' })).toBe('');
  });

  it('emits truecolor, 256 and 16 colour codes', () => {
    expect(at('truecolor').fg('accent')('x')).toBe(
      `${ESC}[38;2;255;0;77mx${ESC}[39m`,
    );
    expect(at('256').fg('accent')('x')).toBe(`${ESC}[38;5;197mx${ESC}[39m`);
    expect(at('16').fg('accent')('x')).toBe(`${ESC}[91mx${ESC}[39m`);
    expect(at('truecolor').bg('bg2')('x')).toBe(
      `${ESC}[48;2;24;24;30mx${ESC}[49m`,
    );
  });

  it('drops surfaces at 16 colours except the selection', () => {
    expect(at('16').bg('bg2')('x')).toBe('x');
    expect(at('16').bg('addBg')('x')).toBe('x');
    expect(at('16').bg('bg3')('x')).toBe(`${ESC}[100mx${ESC}[49m`);
  });

  it('combines attributes and closes only what it opened', () => {
    const style = at('truecolor').style({
      fg: 'warn',
      bold: true,
      italic: true,
    });
    expect(style('x')).toBe(`${ESC}[1;3;38;2;255;181;71mx${ESC}[22;23;39m`);
    expect(at('truecolor').style({ inverse: true })('x')).toBe(
      `${ESC}[7mx${ESC}[27m`,
    );
  });

  it('returns empty text unstyled and caches styles', () => {
    const theme = at('truecolor');
    expect(theme.fg('accent')('')).toBe('');
    expect(theme.fg('accent')).toBe(theme.fg('accent'));
  });

  it('uses the terminal palette slots and no backgrounds', () => {
    const theme = createUiTheme(TERMINAL_PALETTE, 'truecolor', 'terminal');
    expect(theme.fg('accent')('x')).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(theme.fg('fg0')('x')).toBe('x');
    expect(theme.bg('bg2')('x')).toBe('x');
    expect(theme.bg('bg3')('x')).toBe(`${ESC}[100mx${ESC}[49m`);
  });
});

describe('background reassertion', () => {
  const bg = `${ESC}[48;2;24;24;30m`;
  it('re-opens the surface after a nested default-background or reset', () => {
    const inner = `a${ESC}[48;2;1;2;3mcode${ESC}[49mb${ESC}[0mc`;
    expect(reassertBackground(inner, bg)).toBe(
      `a${ESC}[48;2;1;2;3mcode${ESC}[49m${bg}b${ESC}[0m${bg}c`,
    );
  });
  it('leaves colour-only sequences alone, including palette index 0', () => {
    const inner = `${ESC}[38;5;0mx${ESC}[39m ${ESC}[22;39m`;
    expect(reassertBackground(inner, bg)).toBe(inner);
  });
  it('is the identity without a background', () => {
    expect(reassertBackground(`${ESC}[0mx`, '')).toBe(`${ESC}[0mx`);
  });
  it('strips styles', () => {
    expect(stripStyles(`${ESC}[1;38;2;1;2;3mx${ESC}[22;39m`)).toBe('x');
  });
});

describe('glyphs', () => {
  it('spins through the braille frames at 80 ms', () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(80)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(80 * SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(-5)).toBe(SPINNER_FRAMES[0]);
  });
});
