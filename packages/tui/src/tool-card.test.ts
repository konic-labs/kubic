// Tool cards (EPIC N, issue #455; docs/ui 01-D, 01-E, 01-H). Pure renders at
// depth none read like the design; the bash record and the exec truncation
// notice never reach the collapsed card.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import { spinnerFrame } from './theme.js';
import {
  formatToolDuration,
  parseShellText,
  renderToolCard,
  testSummary,
} from './tool-card.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

const NODE_TEST_FAIL = [
  '[bash exit 1 (bash)]',
  '--- stdout ---',
  '▶ cart',
  '  ✔ adds an item (0.51ms)',
  '  ✔ removes an item (0.12ms)',
  '  ✔ totals the cart (0.08ms)',
  '  ✖ adding the same item twice accumulates quantity (0.32ms)',
  '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 3',
  '      at TestContext.<anonymous> (test/cart.test.js:21:12)',
  '▶ cart (2.1ms)',
  ...Array.from({ length: 30 }, (_, i) => `  detail line ${i + 1}`),
  'ℹ tests 4',
  'ℹ pass 3',
  'ℹ fail 1',
].join('\n');

const NODE_TEST_PASS = [
  '[bash exit 0 (bash)]',
  '--- stdout ---',
  '▶ cart',
  '  ✔ adds an item (0.51ms)',
  'ℹ tests 4',
  'ℹ pass 4',
  'ℹ fail 0',
].join('\n');

describe('the bash record (issue #455)', () => {
  it('parses the head, both streams and the spill notice', () => {
    const parsed = parseShellText(
      [
        '[bash exit 2 (sh), timed out, output truncated]',
        '--- stdout ---',
        '[kubic: 1200 leading chars dropped — full output: /tmp/s/stdout.log]',
        'tail of stdout',
        '--- stderr ---',
        'boom',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      exitCode: 2,
      flags: ['timed out', 'output truncated'],
      stdout: ['tail of stdout'],
      stderr: ['boom'],
      spillPaths: ['/tmp/s/stdout.log'],
      clipped: true,
    });
    expect(
      parseShellText('[bash exit none (bash), aborted]\n(no output)'),
    ).toMatchObject({
      exitCode: undefined,
      flags: ['aborted'],
      stdout: [],
      stderr: [],
    });
    expect(parseShellText('plain text')).toBeUndefined();
  });

  it('summarises test runners and formats durations', () => {
    expect(testSummary(NODE_TEST_FAIL.split('\n'))).toBe(
      'tests 4 · pass 3 · fail 1',
    );
    expect(testSummary([' Tests  2 failed | 17 passed (19)'])).toBe(
      '17 passed · 2 failed',
    );
    expect(testSummary(['nothing here'])).toBeUndefined();
    expect(formatToolDuration(3)).toBe('3ms');
    expect(formatToolDuration(410)).toBe('410ms');
    expect(formatToolDuration(1234)).toBe('1.23s');
    expect(formatToolDuration(12_345)).toBe('12.3s');
    expect(formatToolDuration(65_000)).toBe('1:05');
  });
});

describe('tool cards (issue #455; 01-D, 01-H)', () => {
  it('shows a failing test run: error lines first, the tally, the hidden count', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'bash',
        target: 'npm test',
        output: NODE_TEST_FAIL,
        durationMs: 410,
        expanded: false,
        expandKey: '^X',
      },
      100,
    );
    expect(lines[0]).toBe(
      between('  ● bash  npm test', '✕ exit 1 · 410ms ', 100),
    );
    expect(lines.slice(1)).toEqual([
      '  │   ✖ adding the same item twice accumulates quantity (0.32ms)',
      '  │     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 3',
      '  │ tests 4 · pass 3 · fail 1',
      '  └ +39 lines   ^X expand',
    ]);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it('folds a passing test run to its tally', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'bash',
        target: 'npm test',
        output: NODE_TEST_PASS,
        durationMs: 380,
        expanded: false,
      },
      80,
    );
    expect(lines).toEqual([
      between('  ● bash  npm test', '✓ exit 0 · 380ms ', 80),
      '  └ tests 4 · pass 4 · fail 0',
    ]);
    const painted = renderToolCard(
      rich,
      { name: 'bash', output: NODE_TEST_PASS, expanded: false },
      80,
    );
    expect(painted[0]).toContain(rich.fg('ok')('●'));
    expect(painted[0]).toContain(rich.fg('ok')('✓ exit 0'));
  });

  it('never shows the record wrapper or the spill notice collapsed', () => {
    const output = [
      '[bash exit 0 (bash), output truncated]',
      '--- stdout ---',
      '[kubic: 99 leading chars dropped — full output: /tmp/x/stdout.log]',
      'line a',
      'line b',
      '--- stderr ---',
      'warn: something',
    ].join('\n');
    const collapsed = renderToolCard(
      plain,
      {
        name: 'bash',
        target: 'make',
        output,
        expanded: false,
        expandKey: '^X',
      },
      80,
    ).join('\n');
    expect(collapsed).not.toContain('[bash exit');
    expect(collapsed).not.toContain('--- stdout ---');
    expect(collapsed).not.toContain('[kubic:');
    expect(collapsed).toContain('truncated · ✓ exit 0');
    // stderr comes after stdout.
    expect(collapsed.indexOf('line b')).toBeLessThan(
      collapsed.indexOf('warn: something'),
    );
    const expanded = renderToolCard(
      plain,
      { name: 'bash', target: 'make', output, expanded: true },
      80,
    );
    expect(expanded.at(-1)).toBe('  └ full output: /tmp/x/stdout.log');
  });

  it('folds a successful read to one line; a failed read is a full card', () => {
    const read = renderToolCard(
      plain,
      {
        name: 'read',
        target: 'src/cart.js',
        output: '[read src/cart.js: lines 1-32 of 32]\nconst a = 1;',
        durationMs: 3,
        expanded: false,
      },
      80,
    );
    expect(read).toEqual([
      between('  ○ read  src/cart.js', '32 lines · 3ms ', 80),
    ]);
    const grep = renderToolCard(
      plain,
      {
        name: 'grep',
        target: 'TODO',
        output: '[grep /TODO/: 3 matches]\na:1: x',
        expanded: false,
      },
      60,
    );
    expect(grep[0]?.endsWith('3 matches ')).toBe(true);
    const ls = renderToolCard(
      plain,
      {
        name: 'ls',
        target: '.',
        output: '{"entries":["a","b"]}',
        expanded: false,
      },
      60,
    );
    expect(ls[0]?.endsWith('2 entries ')).toBe(true);
    const missing = renderToolCard(
      plain,
      {
        name: 'read',
        target: 'nope.js',
        output: 'ENOENT: no such file or directory',
        isError: true,
        expanded: false,
      },
      80,
    );
    expect(missing[0]).toBe(between('  ● read  nope.js', '✕ failed ', 80));
    expect(missing[1]).toBe('  │ ENOENT: no such file or directory');
    // Expanded, a read is a full card too.
    const open = renderToolCard(
      plain,
      {
        name: 'read',
        target: 'a',
        output: '[read a: lines 1-1 of 1]\nx',
        expanded: true,
      },
      40,
    );
    expect(open).toHaveLength(3);
  });

  it('shows the running and the waiting states', () => {
    const running = renderToolCard(
      plain,
      { name: 'bash', target: 'npm test', runningMs: 3000, expanded: false },
      80,
    );
    expect(running).toEqual([
      between(`  ${spinnerFrame(3000)} bash  npm test`, 'running · 3.00s ', 80),
    ]);
    const waiting = renderToolCard(
      rich,
      { name: 'bash', target: 'rm -rf dist', waiting: true, expanded: false },
      80,
    );
    expect(waiting[0]).toContain(rich.fg('warn')('◆'));
    expect(waiting[0]).toContain(rich.fg('warn')('waiting for approval'));
  });

  it('cuts the target before the outcome on a narrow terminal', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'bash',
        target: 'node --test test/cart.test.js test/other.test.js',
        output: NODE_TEST_PASS,
        durationMs: 380,
        expanded: false,
      },
      40,
    );
    expect(visibleWidth(lines[0] ?? '')).toBe(40);
    expect(lines[0]?.endsWith('✓ exit 0 · 380ms ')).toBe(true);
    expect(lines[0]).toContain('…');
  });
});

describe('file-change cards (issue #456; 01-G)', () => {
  const diffText = [
    ' 8   const existing = cart.items.find((i) => i.name === name);',
    ' 9   if (existing) {',
    '-10     existing.qty = qty;',
    '+10     existing.qty += qty;',
    ' 11   } else {',
  ].join('\n');
  const edit = {
    kind: 'diff' as const,
    text: diffText,
    firstChangedLine: 10,
    added: 1,
    removed: 1,
    truncated: false,
  };

  it('shows the counts and the inline diff under an edit card', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'edit',
        target: 'src/cart.js',
        output: '{"path":"src/cart.js","replacements":1}',
        display: edit,
        durationMs: 9,
        expanded: false,
        expandKey: '^X',
      },
      100,
    );
    expect(lines[0]).toBe(
      between('  ● edit  src/cart.js', '+1 −1 · 9ms ', 100),
    );
    expect(lines.slice(1)).toEqual([
      '  │  8     const existing = cart.items.find((i) => i.name === name);',
      '  │  9     if (existing) {',
      '  │ 10 −     existing.qty = qty;',
      '  │ 10 +     existing.qty += qty;',
      '  │ 11     } else {',
    ]);
    const painted = renderToolCard(
      rich,
      { name: 'edit', output: '{}', display: edit, expanded: false },
      80,
    );
    expect(painted[0]).toContain(rich.fg('add')('+1'));
    expect(painted[0]).toContain(rich.fg('del')('−1'));
  });

  it('collapses a long diff to twelve rows and expands it whole', () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `+${String(i + 1).padStart(2)} line ${i + 1}`,
    );
    const big = { ...edit, text: rows.join('\n'), added: 20, removed: 0 };
    const collapsed = renderToolCard(
      plain,
      {
        name: 'edit',
        target: 'a.ts',
        output: '{}',
        display: big,
        expanded: false,
        expandKey: '^X',
      },
      80,
    );
    expect(collapsed).toHaveLength(1 + 12 + 1);
    expect(collapsed.at(-1)).toBe('  └ +8 more lines   ^X expand');
    const expanded = renderToolCard(
      plain,
      {
        name: 'edit',
        target: 'a.ts',
        output: '{}',
        display: big,
        expanded: true,
      },
      80,
    );
    expect(expanded).toHaveLength(1 + 20);
  });

  it('shows a new file by its size and first lines', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'write',
        target: 'notes.md',
        output: '{"path":"notes.md"}',
        display: {
          kind: 'write',
          newFile: true,
          lines: 10,
          preview: Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join(
            '\n',
          ),
        },
        expanded: false,
        expandKey: '^X',
      },
      80,
    );
    expect(lines[0]).toBe(between('  ● write  notes.md', 'new file +10 ', 80));
    expect(lines[1]).toBe('  │  1 + row 1');
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines.at(-1)).toBe('  └ +2 more lines   ^X expand');
  });

  it('falls back to the op result without a display record (older sessions)', () => {
    const lines = renderToolCard(
      plain,
      {
        name: 'edit',
        target: 'src/cart.js',
        output: '{"path":"src/cart.js","replacements":2,"bytesDelta":3}',
        expanded: false,
      },
      80,
    );
    expect(lines).toEqual([
      between('  ● edit  src/cart.js', '✓ 2 replacements ', 80),
    ]);
    const write = renderToolCard(
      plain,
      {
        name: 'write',
        target: 'a',
        output: '{"path":"a","bytesDelta":-12}',
        expanded: false,
      },
      60,
    );
    expect(write[0]?.endsWith('✓ -12 bytes ')).toBe(true);
  });
});
