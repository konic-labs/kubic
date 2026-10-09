// The TUI kit primitives. Pure renders: plain text at
// depth none (readable snapshots), plus SGR checks at truecolor.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../tui-boundary.js';
import { frameInnerWidth, frameLines } from './frame.js';
import { renderKeyHintRow } from './key-hints.js';
import { exactWidth, fitLine, leftRight, padTo } from './line.js';
import { badge, gauge, sectionLabel } from './marks.js';
import { fuzzyPositions, highlightPositions } from './match.js';
import { fillLine } from './surface.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');
const ESC = '\u001b';

describe('line fitting', () => {
  it('fits, pads and aligns by cells', () => {
    expect(fitLine('abcdef', 4)).toBe('abc…');
    expect(fitLine('abc', 4)).toBe('abc');
    expect(fitLine('abc', 0)).toBe('');
    expect(padTo('ab', 4)).toBe('ab  ');
    expect(exactWidth('abcdef', 4)).toBe('abc…');
    expect(exactWidth('张伟', 6)).toBe('张伟  ');
  });

  it('keeps the right part and truncates the left first', () => {
    expect(leftRight('left', 'right', 12)).toBe('left   right');
    expect(leftRight('a long left side', 'right', 12)).toBe('a lon… right');
    expect(visibleWidth(leftRight('a long left side', 'right', 12))).toBe(12);
    expect(leftRight('left', 'very long right', 8)).toBe('very lo…');
    expect(leftRight('only', '', 6)).toBe('only  ');
    for (const width of [20, 40, 80]) {
      expect(
        visibleWidth(
          leftRight('■ KUBIC │ project', 'approvals on │ 14:02', width),
        ),
      ).toBe(width);
    }
  });
});

describe('surfaces', () => {
  it('fits without padding when there is no background', () => {
    expect(fillLine(plain, 'hello', 10, 'bg2')).toBe('hello');
  });

  it('paints edge to edge and keeps the background through nested styles', () => {
    const open = rich.open({ bg: 'bg2' });
    const inner = `a ${rich.style({ bg: 'bg3' })('code')} b`;
    const line = fillLine(rich, inner, 12, 'bg2');
    expect(line.startsWith(open)).toBe(true);
    expect(line.endsWith(`${ESC}[49m`)).toBe(true);
    expect(visibleWidth(line)).toBe(12);
    // after the inner `49m` the outer surface is re-opened
    expect(line).toContain(`${ESC}[49m${open} b`);
  });
});

describe('frames', () => {
  it('draws a closed light box with a title and a right label', () => {
    const lines = frameLines(plain, ['› hello'], 24, {
      title: 'dispatch',
      rightLabel: '1 of 2',
    });
    expect(lines).toEqual(
      [
        '┌─ dispatch ─ 1 of 2 ──┐',
        '│ › hello              │',
        '└──────────────────────┘',
      ].map((line) => line),
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(24);
  });

  it('draws the heavy left-edge card', () => {
    const lines = frameLines(plain, ['$ rm -rf dist'], 20, {
      weight: 'heavy',
      sides: 'left',
      title: 'APPROVAL',
    });
    expect(lines[0]).toBe('┏━ APPROVAL ━━━━━━━━');
    expect(lines[1]).toBe('┃ $ rm -rf dist');
    expect(lines[2]).toBe('┗━━━━━━━━━━━━━━━━━━━');
  });

  it('drops labels that do not fit and keeps the corners', () => {
    const lines = frameLines(plain, [], 8, { title: 'a very long title' });
    expect(lines[0]).toBe('┌──────┐');
  });

  it('truncates body lines to the inner width, wide characters included', () => {
    expect(frameInnerWidth(20)).toBe(16);
    expect(frameInnerWidth(20, 'left')).toBe(18);
    const lines = frameLines(plain, ['张伟张伟张伟张伟张伟'], 12);
    expect(visibleWidth(lines[1] ?? '')).toBe(12);
  });

  it('paints the border role and a body background', () => {
    const lines = frameLines(rich, ['x'], 10, {
      color: 'warn',
      bodyBg: 'warnBg',
      sides: 'left',
      weight: 'heavy',
    });
    expect(lines[0]).toContain(rich.fg('warn')('┏'));
    expect(lines[0]).toContain(rich.fg('warn')('━━━━━━━━━'));
    expect(lines[1]).toContain(rich.open({ bg: 'warnBg' }));
  });
});

describe('marks', () => {
  it('badges are inverse cells, bracketed without colour', () => {
    expect(badge(plain, 'APPROVAL', 'accent')).toBe('[APPROVAL]');
    expect(badge(rich, 'APPROVAL', 'accent')).toBe(
      rich.style({ fg: 'accent', inverse: true, bold: true })(' APPROVAL '),
    );
    expect(badge(rich, 'a', 'key')).toBe(
      rich.style({ fg: 'fg0', bg: 'bg3', bold: true })(' a '),
    );
  });

  it('gauges fill, warn at 80%, fail at 100% and survive bad input', () => {
    expect(gauge(plain, 0.5, 10)).toBe('━━━━━─────');
    expect(gauge(plain, 0, 4)).toBe('────');
    expect(gauge(plain, 1.3, 4)).toBe('━━━━');
    expect(gauge(plain, Number.NaN, 4)).toBe('────');
    expect(gauge(plain, -1, 4)).toBe('────');
    expect(gauge(rich, 0.5, 4)).toBe(
      `${rich.fg('fg0')('━━')}${rich.fg('fg3')('━━')}`,
    );
    expect(gauge(rich, 0.85, 4)).toContain(rich.fg('warn')('━━━'));
    expect(gauge(rich, 1, 4)).toBe(`${rich.fg('err')('━━━━')}`);
  });

  it('section labels', () => {
    expect(sectionLabel(plain, 'commands')).toBe('COMMANDS');
  });
});

describe('key hints', () => {
  const hints = [
    ['⏎', 'send'],
    ['⇧⏎', 'newline'],
    ['/', 'commands'],
    ['^P', 'palette'],
  ] as const;

  it('lays out keys and labels with the right hint aligned', () => {
    const row = renderKeyHintRow(plain, hints, 60, ['^C ^C', 'quit']);
    expect(
      row.startsWith(' ⏎ send   ⇧⏎ newline   / commands   ^P palette '),
    ).toBe(true);
    expect(row.endsWith(' ^C ^C quit ')).toBe(true);
    expect(visibleWidth(row)).toBe(60);
  });

  it('drops whole hints from the end when narrow', () => {
    const row = renderKeyHintRow(plain, hints, 34, ['^C ^C', 'quit']);
    expect(row).toBe(' ⏎ send   ⇧⏎ newline   ^C ^C quit ');
    expect(renderKeyHintRow(plain, hints, 10)).toBe(' ⏎ send');
  });

  it('colours keys fg1 and labels fg2', () => {
    const row = renderKeyHintRow(rich, [['⏎', 'send']], 20);
    expect(row).toBe(` ${rich.fg('fg1')('⏎')} ${rich.fg('fg2')('send')}`);
  });
});

describe('fuzzy match positions', () => {
  it('prefers a contiguous run', () => {
    expect(fuzzyPositions('mod', '/model')).toEqual([1, 2, 3]);
    expect(fuzzyPositions('MOD', 'src/models.js')).toEqual([4, 5, 6]);
  });

  it('prefers word starts for scattered matches', () => {
    // `cs` → c(laude) s(onnet), not the c in claude… s in claude?
    expect(fuzzyPositions('cs', 'claude-sonnet')).toEqual([0, 7]);
    expect(fuzzyPositions('gs', 'git_status')).toEqual([0, 4]);
    expect(fuzzyPositions('nc', 'newCommand')).toEqual([0, 3]);
  });

  it('returns undefined for no match and [] for an empty query', () => {
    expect(fuzzyPositions('xyz', 'model')).toBeUndefined();
    expect(fuzzyPositions('', 'model')).toEqual([]);
  });

  it('highlights matched runs', () => {
    const mark = (text: string): string => `[${text}]`;
    expect(highlightPositions('/model', [1, 2, 3], mark)).toBe('/[mod]el');
    expect(highlightPositions('claude-sonnet', [0, 7], mark)).toBe(
      '[c]laude-[s]onnet',
    );
    expect(highlightPositions('abc', [], mark)).toBe('abc');
  });

  it('styles the unmatched runs too when asked', () => {
    const mark = (text: string): string => `[${text}]`;
    const rest = (text: string): string => `(${text})`;
    expect(highlightPositions('/model', [1, 2, 3], mark, rest)).toBe(
      '(/)[mod](el)',
    );
    expect(highlightPositions('abc', [], mark, rest)).toBe('(abc)');
  });
});
