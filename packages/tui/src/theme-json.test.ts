// JSON themes ("Themes are JSON with a schema"; v2 token
// roles). The schema, the named validation errors, the
// built-in palettes and the colour-level downgrade of a custom hex colour.
// Pure: text in, palette/theme out — the file read is the composition root's.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  TERMINAL_PALETTE,
} from '../../core/src/ui/tokens.js';
import { editorTheme } from './editor-view.js';
import { StatusBar } from './status-bar.js';
import {
  builtinThemePalette,
  createThemeFromPalette,
  createTuiTheme,
  isThemeBuiltin,
  parseThemeJson,
  setTuiTheme,
  ThemeError,
  tuiTheme,
} from './theme.js';
import { markdownThemeFor } from './transcript.js';

const V1 = JSON.stringify({
  name: 'solarized',
  colors: {
    accent: '#268bd2',
    warm: '#b58900',
    success: '#859900',
    error: '#dc322f',
    warning: '#cb4b16',
    muted: '#93a1a1',
    prompt: '#fdf6e3',
  },
});

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

describe('v1 theme files stay valid', () => {
  it('maps the seven keys onto the dark palette', () => {
    expect(parseThemeJson(V1, 'solarized.json')).toEqual({
      ...DARK_PALETTE,
      accent: '#268bd2',
      ok: '#859900',
      err: '#dc322f',
      warn: '#cb4b16',
      fg2: '#93a1a1',
      fg0: '#fdf6e3',
    });
  });

  it('rejects an unknown v1 key, naming it and the v1 keys', () => {
    const text = JSON.stringify({ colors: { ...v1Colors(), blue: '#00f' } });
    expect(() => parseThemeJson(text, 'extra.json')).toThrow(
      /theme 'extra\.json': unknown colour 'blue' \(a v1 theme uses accent, warm, success, error, warning, muted, prompt\)/,
    );
  });

  it('rejects a missing v1 colour, naming it', () => {
    const { accent: _accent, ...rest } = v1Colors();
    const text = JSON.stringify({ colors: rest });
    expect(() => parseThemeJson(text, 'short.json')).toThrow(
      /theme 'short\.json': missing colour 'accent'/,
    );
  });

  it('rejects a value that is not #rrggbb, naming the key', () => {
    const text = JSON.stringify({ colors: { ...v1Colors(), accent: 'red' } });
    expect(() => parseThemeJson(text, 'bad.json')).toThrow(
      /theme 'bad\.json': 'accent' must be a #rrggbb colour \(got "red"\)/,
    );
  });

  it('refuses extends on a v1 file', () => {
    const text = JSON.stringify({ extends: 'light', colors: v1Colors() });
    expect(() => parseThemeJson(text, 'mixed.json')).toThrow(
      /'extends' needs a v2 theme/,
    );
  });
});

describe('v2 theme files', () => {
  it('overrides any subset of roles on top of dark by default', () => {
    const text = JSON.stringify({
      colors: { accent: '#00aaff', bg2: '#202030' },
    });
    expect(parseThemeJson(text, 'mine.json')).toEqual({
      ...DARK_PALETTE,
      accent: '#00aaff',
      bg2: '#202030',
    });
  });

  it('extends a named built-in', () => {
    const text = JSON.stringify({
      name: 'mine',
      extends: 'light',
      colors: { accent: '#00aaff' },
    });
    expect(parseThemeJson(text, 'mine.json')).toEqual({
      ...LIGHT_PALETTE,
      accent: '#00aaff',
    });
  });

  it('rejects an unknown role, naming the roles', () => {
    const text = JSON.stringify({ colors: { purple: '#aa00aa' } });
    expect(() => parseThemeJson(text, 'r.json')).toThrow(
      /theme 'r\.json': unknown colour 'purple' \(expected token roles: bg0, bg1/,
    );
  });

  it('rejects an unknown base', () => {
    const text = JSON.stringify({ extends: 'solar', colors: {} });
    expect(() => parseThemeJson(text, 'b.json')).toThrow(
      /'extends' must be one of default, dark, light, terminal/,
    );
  });

  it('rejects an unknown top-level key, naming the expected ones', () => {
    const text = JSON.stringify({ colors: {}, palette: {} });
    expect(() => parseThemeJson(text, 't.json')).toThrow(
      /unknown key 'palette' \(expected name, extends, colors\)/,
    );
  });

  it('rejects malformed JSON and a theme without a colors object', () => {
    expect(() => parseThemeJson('{ nope', 'broken.json')).toThrow(ThemeError);
    expect(() => parseThemeJson('{ nope', 'broken.json')).toThrow(
      /theme 'broken\.json': invalid JSON/,
    );
    expect(() => parseThemeJson('{"name":"x"}', 'x.json')).toThrow(
      /theme 'x\.json': 'colors' must be an object/,
    );
    expect(() => parseThemeJson('{"colors":[]}', 'x.json')).toThrow(
      /theme 'x\.json': 'colors' must be an object/,
    );
  });
});

describe('the built-in themes', () => {
  it('ships default, dark, light and terminal', () => {
    for (const name of ['default', 'dark', 'light', 'terminal']) {
      expect(isThemeBuiltin(name)).toBe(true);
    }
    expect(isThemeBuiltin('solarized')).toBe(false);
    expect(builtinThemePalette('default')).toBe(builtinThemePalette('dark'));
    expect(builtinThemePalette('light')).toBe(LIGHT_PALETTE);
    expect(builtinThemePalette('terminal')).toBe(TERMINAL_PALETTE);
  });
});

describe('the colour-level downgrade', () => {
  it('renders a custom colour at every level', () => {
    const truecolor = createThemeFromPalette(LIGHT_PALETTE, 'truecolor');
    const c256 = createThemeFromPalette(LIGHT_PALETTE, '256');
    const c16 = createThemeFromPalette(LIGHT_PALETTE, '16');
    const none = createThemeFromPalette(LIGHT_PALETTE, 'none');
    expect(truecolor.accent('x')).toContain('38;2;');
    expect(c256.accent('x')).toContain('38;5;');
    expect(c16.accent('x')).toMatch(/\[(3|9)[0-7]m/);
    expect(none.accent('x')).toBe('x');
    expect(none.level).toBe('none');
  });

  it('the default theme is the dark palette', () => {
    const styles = [
      'accent',
      'accentBold',
      'warm',
      'success',
      'error',
      'warning',
      'muted',
      'dim',
      'bold',
      'italic',
      'underline',
      'strike',
      'code',
      'prompt',
    ] as const;
    const shipped = createTuiTheme('truecolor');
    const fromPalette = createThemeFromPalette(DARK_PALETTE, 'truecolor');
    expect(styles.map((key) => fromPalette[key]('x'))).toEqual(
      styles.map((key) => shipped[key]('x')),
    );
    expect(shipped.accent('x')).toBe('\u001b[38;2;255;0;77mx\u001b[39m');
  });
});

describe('a light theme on the status bar', () => {
  it('changes the rendered SGR for the status bar', () => {
    const state = {
      model: 'faux/vision',
      thinking: '',
      rows: [],
      approvalsSkipped: false,
      sessionId: 's1',
    };
    setTuiTheme(createTuiTheme('truecolor'));
    const before = new StatusBar(state).render(100).join('\n');
    setTuiTheme(createThemeFromPalette(LIGHT_PALETTE, 'truecolor'));
    const after = new StatusBar(state).render(100).join('\n');
    // The line is painted on each palette's own bg1 surface.
    expect(before).toContain(
      createThemeFromPalette(DARK_PALETTE, 'truecolor').ui.open({ bg: 'bg1' }),
    );
    expect(after).toContain(
      createThemeFromPalette(LIGHT_PALETTE, 'truecolor').ui.open({ bg: 'bg1' }),
    );
    expect(after).not.toBe(before);
    expect(tuiTheme().level).toBe('truecolor');
  });

  // The re-baseline's scope edit: the custom palette must satisfy the
  // pi-tui 1.0.2 per-component interfaces Kubic builds from it.
  it('reaches the pi-tui per-component theme interfaces', () => {
    const theme = createThemeFromPalette(LIGHT_PALETTE, 'truecolor');
    setTuiTheme(theme);
    // Headings fg0 bold, links info — on the light palette.
    expect(markdownThemeFor(theme).heading('x')).toBe(
      '\u001b[1;38;2;24;24;27mx\u001b[22;39m',
    );
    expect(markdownThemeFor(theme).link('x')).toBe(
      '\u001b[38;2;29;78;216mx\u001b[39m',
    );
    // The editor's autocomplete list takes the palette (its
    // rules only carry the frame's marker).
    expect(editorTheme().selectList.selectedPrefix('x')).toBe(
      '\u001b[38;2;208;0;63mx\u001b[39m',
    );
  });
});

// V8's JSON.parse message quotes the input, so a theme
// path pointed at a non-theme file (a credentials file, say) must not print
// that file's content into the boot error.
describe('a parse failure never quotes the file', () => {
  it('reports the position, not the input window', () => {
    const secret = 'sk-live-abcdef1234567890';
    const broken = `{ "name": "${secret}", "colors": }`;
    let message = '';
    try {
      parseThemeJson(broken, 'theme.json');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("theme 'theme.json': invalid JSON");
    expect(message).not.toContain(secret);
    expect(message).not.toContain('sk-live');
  });

  // V8 gives a position for some malformed inputs and only a quoted window
  // for others; when it does, the operator gets the pointer.
  it('still names the position when V8 gives one', () => {
    expect(() => parseThemeJson('{ bad', 'theme.json')).toThrow(
      /theme 'theme\.json': invalid JSON \(line 1 column 3\)/,
    );
  });
});

function v1Colors(): Record<string, string> {
  return {
    accent: '#268bd2',
    warm: '#b58900',
    success: '#859900',
    error: '#dc322f',
    warning: '#cb4b16',
    muted: '#93a1a1',
    prompt: '#fdf6e3',
  };
}
