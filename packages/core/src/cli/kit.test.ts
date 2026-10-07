// The CLI output kit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alignedRows,
  brandHeading,
  errorBlock,
  formatCost,
  formatDuration,
  formatTokens,
  hintLine,
  isFancy,
  kvLine,
  nextActions,
  receipt,
  sectionLabel,
  statusMark,
} from './kit.js';
import { createSpinner } from './spinner.js';
import { createCliTheme } from './theme.js';
import { padVisible, truncateVisible, visibleWidth } from './width.js';

const plain = createCliTheme('none');
const rich = createCliTheme('truecolor');
const ESC = '\u001b';

describe('kit helpers at depth none are plain text', () => {
  it('heading, labels and marks', () => {
    expect(brandHeading(plain, 'run', ['solo', 'faux/echo', '~/x'])).toBe(
      '■ kubic run · solo · faux/echo · ~/x',
    );
    expect(brandHeading(plain, 'doctor')).toBe('■ kubic doctor');
    expect(sectionLabel(plain, 'runtime')).toBe('RUNTIME     ');
    expect(sectionLabel(plain, 'x', 4)).toBe('X   ');
    expect(
      ['ok', 'warn', 'fail', 'skip', 'info'].map((kind) =>
        statusMark(plain, kind as 'ok'),
      ),
    ).toEqual(['✓', '▲', '✕', '○', 'ℹ']);
    expect(statusMark(plain, 'working', 2)).toBe('⠹');
  });

  it('aligned rows continue under the content column', () => {
    expect(
      alignedRows(plain, [
        ['runtime', '✓ node'],
        ['providers', '✓ anthropic\n○ openai — no key'],
      ]),
    ).toEqual([
      'RUNTIME     ✓ node',
      'PROVIDERS   ✓ anthropic',
      '            ○ openai — no key',
    ]);
  });

  it('receipts', () => {
    expect(
      receipt(plain, {
        ok: true,
        durationMs: 18_400,
        tools: 4,
        files: 1,
        added: 1,
        removed: 1,
        tokensIn: 9_200,
        tokensOut: 640,
        costUsd: 0.031,
      }),
    ).toBe('✓ done 18.4s · 4 tools · 1 file +1 −1 · ↑ 9.2k ↓ 640 tok · $0.031');
    expect(
      receipt(plain, {
        ok: false,
        durationMs: 1200,
        outcome: 'timeout',
        tools: 1,
      }),
    ).toBe('✕ failed 1.2s · timeout · 1 tool');
    expect(receipt(plain, { ok: true, files: 0, tools: 0 })).toBe(
      '✓ done 0 tools',
    );
  });

  it('next actions, hints and key/value lines', () => {
    expect(
      nextActions(plain, [
        ['review', 'kubic diff'],
        ['revert', 'kubic undo'],
      ]),
    ).toBe('  review kubic diff   revert kubic undo');
    expect(hintLine(plain, 'did you mean `openai/gpt-5`?')).toBe(
      '  did you mean openai/gpt-5?',
    );
    expect(kvLine(plain, 'session', 'abc', 9)).toBe('session   abc');
  });

  it('error blocks name the input, the fix and the machine code', () => {
    expect(
      errorBlock(plain, {
        message: 'unknown model',
        subject: 'openai/gpt-x',
        source: '--model',
        hints: ['did you mean `openai/gpt-5`? see `kubic models openai`'],
        exitCode: 6,
        code: 'provider_probe_failed',
      }),
    ).toEqual([
      '✕ unknown model openai/gpt-x (from --model)',
      '  did you mean openai/gpt-5? see kubic models openai',
      '  exit 6 · provider_probe_failed',
    ]);
    expect(errorBlock(plain, { message: 'boom' })).toEqual(['✕ boom']);
  });
});

describe('kit helpers in colour', () => {
  it('uses the token roles', () => {
    expect(brandHeading(rich, 'run', ['solo'])).toContain(
      `${ESC}[1;38;2;255;0;77m■ kubic run`,
    );
    expect(statusMark(rich, 'ok')).toBe(rich.ui.fg('ok')('✓'));
    expect(statusMark(rich, 'fail')).toBe(rich.ui.fg('err')('✕'));
    expect(hintLine(rich, 'run `kubic doctor`')).toContain(
      rich.ui.fg('fg1')('kubic doctor'),
    );
    const block = errorBlock(rich, { message: 'boom', exitCode: 2 });
    expect(block[0]).toContain(
      rich.ui.style({ fg: 'err', bold: true })('boom'),
    );
    expect(block[1]).toContain(rich.ui.fg('fg3')('exit 2'));
  });
});

describe('formatting', () => {
  it('durations, tokens and cost', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatTokens(640)).toBe('640');
    expect(formatTokens(9_240)).toBe('9.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.031)).toBe('$0.031');
    expect(formatCost(2.5)).toBe('$2.50');
  });
});

describe('isFancy', () => {
  it('needs a coloured TTY', () => {
    expect(isFancy({ isTTY: true }, { COLORTERM: 'truecolor' })).toBe(true);
    expect(isFancy({ isTTY: false }, { COLORTERM: 'truecolor' })).toBe(false);
    expect(isFancy({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(isFancy({}, {})).toBe(false);
  });
});

describe('width helpers', () => {
  it('measures cells and pads', () => {
    expect(visibleWidth(`${ESC}[31m张伟${ESC}[39m`)).toBe(4);
    expect(padVisible('ab', 4)).toBe('ab  ');
    expect(padVisible('ab', 4, 'right')).toBe('  ab');
    expect(padVisible('abcdef', 4)).toBe('abcdef');
  });
  it('truncates by cells and resets a cut style', () => {
    expect(truncateVisible('abcdef', 4)).toBe('abc…');
    expect(truncateVisible('abc', 4)).toBe('abc');
    expect(truncateVisible('张伟张伟', 5)).toBe('张伟…');
    expect(truncateVisible(`${ESC}[31mabcdef${ESC}[39m`, 4)).toBe(
      `${ESC}[31mabc…${ESC}[0m`,
    );
    expect(truncateVisible('abc', 0)).toBe('');
  });
});

describe('the spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const capture = (isTTY: boolean) => {
    const chunks: string[] = [];
    const hooks: Array<() => void> = [];
    const stream = { isTTY, write: (chunk: string) => chunks.push(chunk) };
    const spinner = createSpinner(stream, plain, {
      onExit: (restore) => {
        hooks.push(restore);
        return () => {
          hooks.splice(hooks.indexOf(restore), 1);
        };
      },
    });
    return { chunks, hooks, spinner };
  };

  it('writes nothing to a non-TTY stream', () => {
    const { chunks, spinner } = capture(false);
    spinner.start('thinking');
    vi.advanceTimersByTime(500);
    spinner.print('✓ read x');
    spinner.stop('✓ done');
    expect(chunks).toEqual([]);
    expect(spinner.active).toBe(false);
  });

  it('animates on a TTY, prints settled lines and restores the cursor', () => {
    const { chunks, hooks, spinner } = capture(true);
    spinner.start('thinking');
    expect(spinner.active).toBe(true);
    expect(hooks).toHaveLength(1);
    expect(chunks[0]).toBe(`${ESC}[?25l`);
    expect(chunks.at(-1)).toBe(`\r${ESC}[2K⠋ thinking`);
    vi.advanceTimersByTime(80);
    expect(chunks.at(-1)).toBe(`\r${ESC}[2K⠙ thinking`);
    spinner.update('writing');
    expect(chunks.at(-1)).toBe(`\r${ESC}[2K⠙ writing`);
    spinner.print('✓ read x');
    expect(chunks.at(-2)).toBe(`\r${ESC}[2K✓ read x\n`);
    expect(chunks.at(-1)).toBe(`\r${ESC}[2K⠙ writing`);
    spinner.stop('✓ done');
    expect(spinner.active).toBe(false);
    expect(hooks).toHaveLength(0);
    expect(chunks.slice(-3)).toEqual([
      `\r${ESC}[2K`,
      '✓ done\n',
      `${ESC}[?25h`,
    ]);
    const count = chunks.length;
    vi.advanceTimersByTime(500);
    expect(chunks).toHaveLength(count);
  });

  it('restores the cursor when the process exits mid-spin', () => {
    const { chunks, hooks, spinner } = capture(true);
    spinner.start('x');
    hooks[0]?.();
    expect(chunks.at(-1)).toBe(`${ESC}[?25h`);
  });
});
