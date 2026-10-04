// JSON themes (issue #304; §16.9 "Themes are JSON with a schema").
// The schema, the named validation errors, the built-in light/dark palettes
// and the colour-level downgrade of a custom hex colour. Pure: text in,
// theme out — the file read is the composition root's.
import { afterEach, describe, expect, it } from 'vitest';
import { editorTheme } from './editor-view.js';
import { StatusBar } from './status-bar.js';
import {
  builtinThemeColors,
  createThemeFromColors,
  createTuiTheme,
  parseThemeJson,
  setTuiTheme,
  ThemeError,
  tuiTheme,
} from './theme.js';
import { markdownThemeFor } from './transcript.js';

const VALID = JSON.stringify({
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

describe('the JSON theme schema (issue #304)', () => {
  it('accepts a valid theme file and keeps its colours', () => {
    expect(parseThemeJson(VALID, 'solarized.json')).toEqual({
      accent: '#268bd2',
      warm: '#b58900',
      success: '#859900',
      error: '#dc322f',
      warning: '#cb4b16',
      muted: '#93a1a1',
      prompt: '#fdf6e3',
    });
  });

  it('rejects malformed JSON, naming the file', () => {
    expect(() => parseThemeJson('{ nope', 'broken.json')).toThrow(ThemeError);
    expect(() => parseThemeJson('{ nope', 'broken.json')).toThrow(
      /theme 'broken\.json': invalid JSON/,
    );
  });

  it('rejects an unknown key, naming it and the expected ones', () => {
    const text = JSON.stringify({ colors: { ...validColors(), blue: '#00f' } });
    expect(() => parseThemeJson(text, 'extra.json')).toThrow(
      /theme 'extra\.json': unknown colour 'blue' \(expected accent, warm, success, error, warning, muted, prompt\)/,
    );
  });

  it('rejects a missing colour, naming it', () => {
    const { accent: _accent, ...rest } = validColors();
    const text = JSON.stringify({ colors: rest });
    expect(() => parseThemeJson(text, 'short.json')).toThrow(
      /theme 'short\.json': missing colour 'accent'/,
    );
  });

  it('rejects a value that is not #rrggbb, naming the key', () => {
    const text = JSON.stringify({
      colors: { ...validColors(), accent: 'red' },
    });
    expect(() => parseThemeJson(text, 'bad.json')).toThrow(
      /theme 'bad\.json': 'accent' must be a #rrggbb colour \(got "red"\)/,
    );
  });

  it('rejects a theme without a colors object', () => {
    expect(() => parseThemeJson('{"name":"x"}', 'x.json')).toThrow(
      /theme 'x\.json': 'colors' must be an object/,
    );
    expect(() => parseThemeJson('{"colors":[]}', 'x.json')).toThrow(
      /theme 'x\.json': 'colors' must be an object/,
    );
  });
});

describe('the built-in themes (issue #304)', () => {
  it('ships default, dark and light; dark is the shipped brand palette', () => {
    expect(builtinThemeColors('dark')).toEqual(builtinThemeColors('default'));
    expect(builtinThemeColors('dark')).not.toEqual(builtinThemeColors('light'));
    expect(builtinThemeColors('light').prompt).toBe('#18181b');
  });
});

describe('the colour-level downgrade (issue #304)', () => {
  it('renders a custom colour at every level', () => {
    const colors = builtinThemeColors('light');
    const truecolor = createThemeFromColors(colors, 'truecolor');
    const c256 = createThemeFromColors(colors, '256');
    const c16 = createThemeFromColors(colors, '16');
    const none = createThemeFromColors(colors, 'none');
    expect(truecolor.accent('x')).toContain('38;2;');
    expect(c256.accent('x')).toContain('38;5;');
    expect(c16.accent('x')).toMatch(/\[3[0-9]m/);
    expect(none.accent('x')).toBe('x');
    expect(none.level).toBe('none');
  });

  it('keeps the brand palette byte-identical to the shipped theme', () => {
    // The built-in default must not move: existing snapshots pin its SGR.
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
    const fromColors = createThemeFromColors(
      builtinThemeColors('default'),
      'truecolor',
    );
    expect(styles.map((key) => fromColors[key]('x'))).toEqual(
      styles.map((key) => shipped[key]('x')),
    );
  });
});

describe('a light theme on the status bar (issue #304)', () => {
  it('changes the rendered SGR for the status bar', () => {
    const state = {
      model: 'faux/vision',
      thinking: '',
      rows: [],
      mode: 'solo' as const,
      approvalsSkipped: false,
      sessionId: 's1',
    };
    setTuiTheme(createTuiTheme('truecolor'));
    const before = new StatusBar(state).render(100).join('\n');
    setTuiTheme(
      createThemeFromColors(builtinThemeColors('light'), 'truecolor'),
    );
    const after = new StatusBar(state).render(100).join('\n');
    expect(before).toContain('\u001b[38;2;255;0;77m');
    expect(after).toContain('\u001b[38;2;196;0;56m');
    expect(after).not.toBe(before);
    expect(tuiTheme().level).toBe('truecolor');
  });

  // The EPIC K re-baseline's scope edit: the custom palette must satisfy the
  // pi-tui 1.0.2 per-component interfaces Kubic builds from it.
  it('reaches the pi-tui per-component theme interfaces', () => {
    const theme = createThemeFromColors(
      builtinThemeColors('light'),
      'truecolor',
    );
    setTuiTheme(theme);
    expect(markdownThemeFor(theme).heading('x')).toBe(
      '\u001b[1;38;2;196;0;56mx\u001b[22;39m',
    );
    expect(editorTheme().borderColor('x')).toBe(
      '\u001b[38;2;196;0;56mx\u001b[39m',
    );
  });
});

function validColors(): Record<string, string> {
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
