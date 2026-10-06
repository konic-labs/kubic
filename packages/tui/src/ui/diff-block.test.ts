// The inline diff block (EPIC N, issue #456; docs/ui 01-G): display-diff
// rows, line numbers, add/del surfaces and the word-level highlight.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { visibleWidth } from '../tui-boundary.js';
import { parseDisplayDiff, renderDiffRows, wordDiff } from './diff-block.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const CART = [
  '  8   const existing = cart.items.find((i) => i.name === name);',
  '  9   if (existing) {',
  '-10     existing.qty = qty;',
  '+10     existing.qty += qty;',
  ' 11   } else {',
].join('\n');

describe('display diff rows (issue #456)', () => {
  it('parses context, removed, added and gap rows of every number width', () => {
    expect(parseDisplayDiff(CART)).toEqual([
      {
        kind: 'context',
        number: '8',
        text: '  const existing = cart.items.find((i) => i.name === name);',
      },
      { kind: 'context', number: '9', text: '  if (existing) {' },
      { kind: 'del', number: '10', text: '    existing.qty = qty;' },
      { kind: 'add', number: '10', text: '    existing.qty += qty;' },
      { kind: 'context', number: '11', text: '  } else {' },
    ]);
    expect(parseDisplayDiff('-1 a\n+1 b\n   ...\n 1200 c')).toEqual([
      { kind: 'del', number: '1', text: 'a' },
      { kind: 'add', number: '1', text: 'b' },
      { kind: 'gap', number: '', text: '' },
      { kind: 'context', number: '1200', text: 'c' },
    ]);
  });

  it('marks only the changed tokens, and skips rewrites and long lines', () => {
    const operator = wordDiff('existing.qty = qty;', 'existing.qty += qty;');
    expect(operator?.a.filter((_, i) => operator.before[i])).toEqual(['=']);
    expect(operator?.b.filter((_, i) => operator.after[i])).toEqual(['+=']);
    const rename = wordDiff(
      'const total = sum(items);',
      'const subtotal = sum(items);',
    );
    expect(rename?.b.filter((_, i) => rename.after[i])).toEqual(['subtotal']);
    expect(wordDiff('alpha beta gamma', 'one two three four')).toBeUndefined();
    expect(wordDiff('x'.repeat(401), 'y')).toBeUndefined();
  });
});

describe('diff block render (issue #456; 01-G)', () => {
  it('reads like the design at depth none', () => {
    const lines = renderDiffRows(plain, parseDisplayDiff(CART), 80);
    expect(lines).toEqual([
      ' 8     const existing = cart.items.find((i) => i.name === name);',
      ' 9     if (existing) {',
      '10 −     existing.qty = qty;',
      '10 +     existing.qty += qty;',
      '11     } else {',
    ]);
  });

  it('paints add and del surfaces edge to edge with the word highlight', () => {
    const lines = renderDiffRows(rich, parseDisplayDiff(CART), 60);
    const del = lines[2] ?? '';
    const add = lines[3] ?? '';
    expect(del.startsWith(rich.open({ bg: 'delBg' }))).toBe(true);
    expect(add.startsWith(rich.open({ bg: 'addBg' }))).toBe(true);
    expect(visibleWidth(del)).toBe(60);
    expect(visibleWidth(add)).toBe(60);
    // The changed operator sits on the stronger word surface (#164a2a /
    // #4a1220 on the dark palette), bold.
    expect(add).toMatch(/\[1;[0-9;]*48;2;22;74;42m\+=/);
    expect(del).toMatch(/\[1;[0-9;]*48;2;74;18;32m=/);
    // The gap row is an fg3 ellipsis under the numbers.
    expect(renderDiffRows(rich, parseDisplayDiff('   ...'), 20)[0]).toBe(
      rich.fg('fg3')('⋮'),
    );
  });

  it('cuts a long line to the width', () => {
    const rows = parseDisplayDiff(`+1 ${'x'.repeat(200)}`);
    const [line] = renderDiffRows(plain, rows, 40);
    expect(visibleWidth(line ?? '')).toBe(40);
    expect(line?.endsWith('…')).toBe(true);
  });
});
