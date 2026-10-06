// The CLI render matrix (EPIC N, issue #468): the kit's own surfaces — the
// brand heading, labels, hints, aligned rows, the run receipt, next steps,
// the error block and the tables — for every palette (dark, light,
// terminal) × colour level (truecolor, 256, 16, none). Each line must carry
// no escape at depth none and close every style it opens. (The doctor,
// models and help renders run the same matrix in their own packages.)
import { describe, expect, it } from 'vitest';
import type { ColorLevel } from '../ui/color.js';
import { openStyles } from '../ui/style.js';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  type Palette,
  TERMINAL_PALETTE,
} from '../ui/tokens.js';
import {
  alignedRows,
  brandHeading,
  errorBlock,
  hintLine,
  kvLine,
  nextActions,
  receipt,
  sectionLabel,
  statusMark,
} from './kit.js';
import { renderTable } from './table.js';
import { type CliTheme, createCliTheme } from './theme.js';
import { visibleWidth, wrapVisible } from './width.js';

const PALETTES: ReadonlyArray<readonly [string, Palette]> = [
  ['dark', DARK_PALETTE],
  ['light', LIGHT_PALETTE],
  ['terminal', TERMINAL_PALETTE],
];
const LEVELS: readonly ColorLevel[] = ['truecolor', '256', '16', 'none'];

const SURFACES: ReadonlyArray<
  readonly [string, (theme: CliTheme) => readonly string[]]
> = [
  [
    'brand heading',
    (t) => [brandHeading(t, 'run', ['solo', 'faux/echo', '~/proj'])],
  ],
  ['section label', (t) => [sectionLabel(t, 'runtime')]],
  [
    'hint',
    (t) => [hintLine(t, 'run `kubic doctor` to see why, or `kubic models`')],
  ],
  ['key/value', (t) => [kvLine(t, 'session', '01a1…9229', 10)]],
  [
    'aligned rows',
    (t) =>
      alignedRows(t, [
        ['provider', 'faux/echo\ntesting only'],
        ['journal', 'on'],
      ]),
  ],
  [
    'status marks',
    (t) =>
      (['ok', 'warn', 'fail', 'skip', 'info', 'working'] as const).map((kind) =>
        statusMark(t, kind),
      ),
  ],
  [
    'run receipt',
    (t) => [
      receipt(t, {
        ok: true,
        durationMs: 18_400,
        tools: 4,
        files: 1,
        added: 3,
        removed: 0,
        tokensIn: 9_200,
        tokensOut: 640,
        costUsd: 0.031,
      }),
      receipt(t, { ok: false, durationMs: 1_000 }),
    ],
  ],
  [
    'next steps',
    (t) => [
      nextActions(t, [
        ['review', 'kubic diff'],
        ['revert', 'kubic undo'],
      ]),
    ],
  ],
  [
    'error block',
    (t) =>
      errorBlock(t, {
        message: 'no provider has a key',
        subject: 'model',
        source: 'config',
        hints: ['set `ANTHROPIC_API_KEY`', 'or run `kubic models`'],
        exitCode: 6,
        code: 'no_model',
      }),
  ],
  [
    'tables',
    (t) => {
      const rows = [
        [
          'worker-1',
          'running',
          '3:10',
          'a long task that keeps going and going',
        ],
        ['worker-2', 'failed', '0:42', 'docs'],
      ];
      const columns = [
        { header: 'ID' },
        { header: 'STATUS' },
        { header: 'AGE', align: 'right' as const },
        { header: 'TASK' },
      ];
      return [
        ...renderTable(rows, columns).split('\n'),
        ...renderTable(rows, columns, {
          fancy: true,
          theme: t,
          markers: ['●', undefined],
        }).split('\n'),
      ];
    },
  ],
];

describe('the CLI render matrix (issue #468)', () => {
  it('every kit surface closes its styles, and carries none at depth none, in every palette and level', () => {
    const failures: string[] = [];
    for (const [paletteName, palette] of PALETTES) {
      for (const level of LEVELS) {
        const theme = createCliTheme(level, palette, paletteName);
        for (const [name, render] of SURFACES) {
          const lines = render(theme).flatMap((line) => line.split('\n'));
          lines.forEach((line, index) => {
            const where = `${name} · ${paletteName}/${level} line ${index}`;
            if (level === 'none' && line.includes('\u001b')) {
              failures.push(`${where}: escape at depth none`);
            }
            const open = openStyles(line);
            if (open.length > 0) {
              failures.push(`${where}: leaves ${open.join(', ')} open`);
            }
          });
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('a table stays within the widest row it was given', () => {
    const theme = createCliTheme('truecolor', LIGHT_PALETTE, 'light');
    const lines = renderTable(
      [['a', 'b']],
      [{ header: 'ONE' }, { header: 'TWO' }],
      { fancy: true, theme },
    ).split('\n');
    const widest = Math.max(...lines.map((line) => visibleWidth(line)));
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(widest);
  });
});

describe('wrapVisible (issue #468)', () => {
  it('breaks at spaces, cuts a word wider than a row, and drops nothing', () => {
    expect(wrapVisible('one two three four', 9)).toEqual([
      'one two',
      'three',
      'four',
    ]);
    expect(wrapVisible('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapVisible('', 10)).toEqual(['']);
    const text = 'source=default, filesystem=workspace-write, shell=true';
    expect(wrapVisible(text, 12).join(' ').replace(/\s+/g, '')).toBe(
      text.replace(/\s+/g, ''),
    );
  });
});
