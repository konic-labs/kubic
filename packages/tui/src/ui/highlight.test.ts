// Syntax highlighting: calm roles over lowlight's
// scopes, plain fallbacks that never throw.
import { beforeAll, describe, expect, it } from 'vitest';
import { createUiTheme, stripStyles } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import {
  HIGHLIGHT_MAX_LINES,
  highlightCode,
  highlighterReady,
  loadHighlighter,
} from './highlight.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

beforeAll(async () => {
  await loadHighlighter();
});

describe('code highlighting', () => {
  it('loads the grammars on demand', () => {
    expect(highlighterReady()).toBe(true);
  });

  it('maps keywords, strings, numbers and comments onto calm roles', () => {
    const [line] = highlightCode(
      rich,
      "const total = 42; // sum\nlet s = 'x';",
      'ts',
    );
    expect(line).toContain(rich.style({ fg: 'fg0', bold: true })('const'));
    expect(line).toContain(rich.fg('warn')('42'));
    expect(line).toContain(rich.style({ fg: 'fg2', italic: true })('// sum'));
    const lines = highlightCode(
      rich,
      "const total = 42;\nlet s = 'x';",
      'typescript',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(rich.fg('add')("'x'"));
  });

  it('keeps every line and its text for json, bash, python and diff', () => {
    const samples: Array<[string, string]> = [
      ['json', '{\n  "a": [1, true, null]\n}'],
      ['bash', 'npm test -- --watch\necho "done" # ok'],
      ['python', 'def f(x):\n    return x + 1  # inc'],
      ['diff', '-old line\n+new line\n context'],
    ];
    for (const [language, code] of samples) {
      const lines = highlightCode(rich, code, language);
      expect(lines.map(stripStyles)).toEqual(code.split('\n'));
    }
    expect(highlightCode(rich, '-a\n+b', 'diff')[1]).toContain(
      rich.fg('add')('+b'),
    );
  });

  it('falls back to plain fg1 for unknown languages, no language and big blocks', () => {
    expect(highlightCode(rich, 'x = 1', 'nosuchlang')).toEqual([
      rich.fg('fg1')('x = 1'),
    ]);
    expect(highlightCode(rich, 'x = 1')).toEqual([rich.fg('fg1')('x = 1')]);
    const big = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, () => 'x').join(
      '\n',
    );
    expect(highlightCode(rich, big, 'ts')[0]).toBe(rich.fg('fg1')('x'));
  });

  it('returns the input unchanged at depth none', () => {
    expect(highlightCode(plain, 'const a = 1;\n// c', 'ts')).toEqual([
      'const a = 1;',
      '// c',
    ]);
  });
});
