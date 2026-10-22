// The display diff of a file change: Pi's display form
// with line numbers, context and gap rows, counted.
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_DIFF_MAX_ROWS,
  displayDiff,
  writeDisplay,
} from './display-diff.js';

const lines = (count: number, at = 1): string[] =>
  Array.from({ length: count }, (_, i) => `line ${i + at}`);

describe('display diff', () => {
  it('shows one replaced line with three lines of context on each side', () => {
    const before = [...lines(9), '  existing.qty = qty;', ...lines(5, 11)].join(
      '\n',
    );
    const after = [...lines(9), '  existing.qty += qty;', ...lines(5, 11)].join(
      '\n',
    );
    const diff = displayDiff(before, after);
    expect(diff).toEqual({
      kind: 'diff',
      text: [
        '  7 line 7',
        '  8 line 8',
        '  9 line 9',
        '-10   existing.qty = qty;',
        '+10   existing.qty += qty;',
        ' 11 line 11',
        ' 12 line 12',
        ' 13 line 13',
      ].join('\n'),
      firstChangedLine: 10,
      added: 1,
      removed: 1,
    });
  });

  it('joins distant hunks with a gap row and numbers each side', () => {
    const before = lines(30);
    const after = [...before];
    after[2] = 'changed three';
    after.splice(25, 0, 'inserted');
    const diff = displayDiff(before.join('\n'), after.join('\n'));
    const rows = diff?.text.split('\n') ?? [];
    expect(rows).toContain('- 3 line 3');
    expect(rows).toContain('+ 3 changed three');
    expect(rows).toContain('    ...');
    expect(rows).toContain('+26 inserted');
    expect(diff).toMatchObject({ added: 2, removed: 1, firstChangedLine: 3 });
  });

  it('counts a pure insertion and a pure deletion', () => {
    expect(displayDiff('a\nb', 'a\nx\nb')).toMatchObject({
      text: ' 1 a\n+2 x\n 3 b',
      added: 1,
      removed: 0,
    });
    expect(displayDiff('a\nx\nb', 'a\nb')).toMatchObject({
      text: ' 1 a\n-2 x\n 2 b',
      added: 0,
      removed: 1,
    });
    expect(displayDiff('same', 'same')).toBeUndefined();
  });

  it('bounds a huge middle and the row count', () => {
    const before = lines(2000).join('\n');
    const after = lines(2000, 5000).join('\n');
    const diff = displayDiff(before, after);
    expect(diff?.removed).toBe(2000);
    expect(diff?.added).toBe(2000);
    expect(diff?.truncated).toBe(true);
    expect(diff?.text.split('\n')).toHaveLength(DISPLAY_DIFF_MAX_ROWS);
  });

  it('describes a new file by its size and first lines', () => {
    expect(writeDisplay('one\ntwo\nthree\n')).toEqual({
      kind: 'write',
      newFile: true,
      lines: 3,
      preview: 'one\ntwo\nthree',
    });
    expect(writeDisplay('')).toMatchObject({ lines: 0, preview: '' });
  });
});
