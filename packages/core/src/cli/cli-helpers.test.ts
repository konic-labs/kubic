import { describe, expect, it, vi } from 'vitest';
import {
  CliExitError,
  CliUsageError,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeForParseError,
} from './exit-codes.js';
import { createLineLogger, createLogger, debugEnabled } from './logger.js';
import { formatJson, outputModeFor } from './output.js';
import { promptConfirm } from './prompt.js';
import { renderTable } from './table.js';
import { createCliTheme, detectColorLevel } from './theme.js';

const ESC = String.fromCharCode(27);

vi.mock('@clack/prompts', () => {
  const cancel = Symbol('clack:cancel');
  return {
    isCancel: (value: unknown) => value === cancel,
    confirm: vi.fn(async () => true),
    cancel,
  };
});

describe('exit codes (§78, docs/cli/exit-codes.md)', () => {
  it('maps help and version to success', () => {
    expect(exitCodeForParseError('commander.helpDisplayed', 0)).toBe(EXIT_OK);
    expect(exitCodeForParseError('commander.version', 0)).toBe(EXIT_OK);
    expect(exitCodeForParseError('commander.help', 0)).toBe(EXIT_OK);
  });

  it('maps parse failures to the usage code, not commander 1', () => {
    for (const code of [
      'commander.unknownOption',
      'commander.missingArgument',
      'commander.optionMissingArgument',
      'commander.missingMandatoryOptionValue',
      'commander.invalidArgument',
      'commander.invalidOptionArgument',
      'commander.excessArguments',
      'commander.conflictingOption',
    ]) {
      expect(exitCodeForParseError(code, 1), code).toBe(EXIT_USAGE);
    }
    expect(exitCodeForParseError('commander.help', 1)).toBe(EXIT_USAGE);
  });

  it('maps an unknown command (top-level or subcommand) to the usage code', () => {
    expect(exitCodeForParseError('commander.unknownCommand', 1)).toBe(
      EXIT_USAGE,
    );
  });

  it('falls back on commander’s own exit for anything else', () => {
    expect(exitCodeForParseError('commander.other', 0)).toBe(EXIT_OK);
    expect(exitCodeForParseError('commander.other', 7)).toBe(EXIT_FAILED);
  });

  it('error classes carry their exit code and message', () => {
    const usage = new CliUsageError('bad flag');
    expect(usage.exitCode).toBe(EXIT_USAGE);
    expect(usage.message).toBe('bad flag');
    expect(usage.name).toBe('CliUsageError');
    const exit = new CliExitError(5, 'no session');
    expect(exit.exitCode).toBe(5);
    expect(exit.name).toBe('CliExitError');
  });
});

describe('theme', () => {
  it('detects the colour level from env and TTY', () => {
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }, true)).toBe(
      'none',
    );
    expect(detectColorLevel({ NO_COLOR: '' }, false)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: '0' }, true)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: 'false' }, true)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(detectColorLevel({ FORCE_COLOR: '2' }, false)).toBe('256');
    expect(detectColorLevel({ FORCE_COLOR: '1' }, false)).toBe('16');
    expect(detectColorLevel({ FORCE_COLOR: 'true' }, false)).toBe('16');
    expect(detectColorLevel({ FORCE_COLOR: '' }, false)).toBe('16');
    expect(detectColorLevel({}, false)).toBe('none');
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe('none');
    expect(detectColorLevel({ COLORTERM: 'TrueColor' }, true)).toBe(
      'truecolor',
    );
    expect(detectColorLevel({ COLORTERM: '24bit' }, true)).toBe('truecolor');
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm-direct' }, true)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm' }, true)).toBe('16');
  });

  it('level none is the identity; truecolor emits the Konic red', () => {
    const plain = createCliTheme('none');
    expect(plain.enabled).toBe(false);
    expect(plain.accent('x')).toBe('x');
    expect(plain.error('x')).toBe('x');
    const rich = createCliTheme('truecolor');
    expect(rich.enabled).toBe(true);
    expect(rich.accent('x')).toBe(`${ESC}[38;2;255;0;77mx${ESC}[39m`);
    expect(rich.success('x')).toContain('38;2;94;214;140');
    expect(rich.warning('x')).toContain('38;2;255;181;71');
    expect(rich.muted('x')).toContain('38;2;106;106;117');
    expect(rich.code('x')).toContain('38;2;236;236;241');
    expect(rich.bold('x')).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(rich.dim('x')).toBe(`${ESC}[2mx${ESC}[22m`);
    expect(createCliTheme('16').accent('x')).not.toBe('x');
  });
});

describe('logger', () => {
  function capture(debug?: boolean) {
    const chunks: string[] = [];
    const logger = createLogger({
      write: (chunk) => chunks.push(chunk),
      ...(debug === undefined ? {} : { debug }),
    });
    return { chunks, logger };
  }

  it('writes one `<level>: <message>` line per call', () => {
    const { chunks, logger } = capture();
    logger.error('boom');
    logger.warn('careful');
    logger.info('hello');
    logger.success('done');
    expect(chunks).toEqual([
      'error: boom\n',
      'warn: careful\n',
      'info: hello\n',
      'ok: done\n',
    ]);
  });

  it('never collapses identical consecutive lines', () => {
    const { chunks, logger } = capture();
    for (let i = 0; i < 8; i++) logger.warn('same');
    expect(chunks).toHaveLength(8);
  });

  it('debug is silent unless enabled', () => {
    const off = capture();
    off.logger.debug('hidden');
    expect(off.chunks).toEqual([]);
    const on = capture(true);
    on.logger.debug('shown');
    expect(on.chunks).toEqual(['debug: shown\n']);
  });

  it('uses status marks with a coloured theme (issue #450)', () => {
    const chunks: string[] = [];
    const theme = createCliTheme('truecolor');
    const logger = createLogger({
      write: (chunk) => chunks.push(chunk),
      theme,
    });
    logger.error('x');
    logger.warn('y');
    logger.info('z');
    logger.success('w');
    expect(chunks[0]).toBe(`${theme.ui.fg('err')('✕')} x\n`);
    expect(chunks[1]).toBe(`${theme.ui.fg('warn')('▲')} y\n`);
    expect(chunks[2]).toBe(`${theme.ui.fg('info')('ℹ')} z\n`);
    expect(chunks[3]).toBe(`${theme.ui.fg('ok')('✓')} w\n`);
    expect(chunks[0]).toContain(ESC);
  });

  it('createLineLogger writes whole lines to a line channel (no trailing newline)', () => {
    const lines: string[] = [];
    const logger = createLineLogger((line) => lines.push(line));
    logger.error('boom');
    logger.warn('careful');
    expect(lines).toEqual(['error: boom', 'warn: careful']);
  });

  it('--debug or KUBIC_DEBUG=1 enables debug', () => {
    expect(debugEnabled({ debug: true }, {})).toBe(true);
    expect(debugEnabled({}, { KUBIC_DEBUG: '1' })).toBe(true);
    expect(debugEnabled({}, { KUBIC_DEBUG: '0' })).toBe(false);
    expect(debugEnabled({ debug: false }, {})).toBe(false);
  });
});

describe('table', () => {
  const columns = [
    { header: 'ID' },
    { header: 'COST', align: 'right' as const },
    { header: 'NAME' },
  ];
  const rows = [
    ['a', '1.5', 'first'],
    ['bbbb', '10', 'second'],
  ];

  it('renders plain aligned text by default (no trailing spaces)', () => {
    expect(renderTable(rows, columns)).toBe(
      ['ID    COST  NAME', 'a      1.5  first', 'bbbb    10  second'].join(
        '\n',
      ),
    );
  });

  it('measures visible width, not ANSI bytes, and fills missing cells', () => {
    const coloured = createCliTheme('truecolor').accent('a');
    const out = renderTable(
      [[coloured], ['bb', 'x']],
      [{ header: 'K' }, { header: 'V' }],
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('K   V');
    expect(lines[1]).toBe(`${coloured}`);
    expect(lines[2]).toBe('bb  x');
  });

  it('measures terminal display width: wide CJK cells, combining marks', () => {
    const out = renderTable(
      [
        ['张伟', 'first'],
        ['Bob', 'second'],
        ['e\u0301te\u0301', 'third'],
      ],
      [{ header: 'AUTHOR' }, { header: 'MESSAGE' }],
    );
    expect(out.split('\n')).toEqual([
      'AUTHOR  MESSAGE',
      '张伟    first',
      'Bob     second',
      'e\u0301te\u0301     third',
    ]);
  });

  it('pads a right-aligned last column', () => {
    expect(
      renderTable([['1'], ['100']], [{ header: 'N', align: 'right' }]),
    ).toBe('  N\n  1\n100');
  });

  it('renders the borderless kit table when fancy (issue #445)', () => {
    const out = renderTable(rows, columns, {
      fancy: true,
      theme: createCliTheme('none'),
    });
    expect(out.split('\n')).toEqual([
      'ID    COST  NAME',
      '─'.repeat(18),
      'a      1.5  first',
      'bbbb    10  second',
    ]);
    expect(out).not.toContain('┌');
    expect(renderTable(rows, columns, { fancy: true })).toContain('NAME');
  });

  it('styles the kit header and rule, and draws row markers', () => {
    const theme = createCliTheme('truecolor');
    const out = renderTable(rows, columns, {
      fancy: true,
      theme,
      markers: ['●', undefined],
    });
    const lines = out.split('\n');
    expect(lines[0]).toContain(theme.ui.style({ fg: 'fg2', bold: true })('ID'));
    expect(lines[1]).toBe(theme.ui.fg('fg3')('─'.repeat(20)));
    expect(lines[2]?.startsWith('● a')).toBe(true);
    expect(lines[3]?.startsWith('  bbbb')).toBe(true);
  });
});

describe('prompts', () => {
  it('a non-interactive confirm answers the declared value without prompting', async () => {
    const clack = await import('@clack/prompts');
    vi.mocked(clack.confirm).mockClear();
    expect(
      await promptConfirm({
        message: 'q',
        interactive: false,
        nonInteractive: false,
      }),
    ).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('an interactive confirm returns the answer; cancellation is null', async () => {
    const clack = await import('@clack/prompts');
    expect(
      await promptConfirm({
        message: 'q',
        interactive: true,
        nonInteractive: false,
      }),
    ).toBe(true);
    const cancel = (clack as unknown as { cancel: symbol }).cancel;
    vi.mocked(clack.confirm).mockResolvedValueOnce(cancel as never);
    expect(
      await promptConfirm({
        message: 'q',
        interactive: true,
        nonInteractive: false,
      }),
    ).toBeNull();
  });
});

describe('output mode and json', () => {
  it('formats JSON with two-space indent', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('--json turns off interactivity and fancy rendering', () => {
    const tty = { stdinTTY: true, stdoutTTY: true, colorEnabled: true };
    expect(outputModeFor({ ...tty, json: false })).toEqual({
      json: false,
      interactive: true,
      fancy: true,
    });
    expect(outputModeFor({ ...tty, json: true })).toEqual({
      json: true,
      interactive: false,
      fancy: false,
    });
    expect(outputModeFor({ ...tty, json: false, stdoutTTY: false })).toEqual({
      json: false,
      interactive: false,
      fancy: false,
    });
    expect(
      outputModeFor({ ...tty, json: false, colorEnabled: false }).fancy,
    ).toBe(false);
  });
});
