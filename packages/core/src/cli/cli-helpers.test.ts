import { describe, expect, it, vi } from 'vitest';
import {
  CliExitError,
  CliUsageError,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeForParseError,
} from './exit-codes.js';
import { createLogger, debugEnabled } from './logger.js';
import { formatJson, outputModeFor } from './output.js';
import {
  canPrompt,
  promptConfirm,
  promptSelect,
  promptText,
  startSpinner,
} from './prompt.js';
import { renderTable } from './table.js';
import { createCliTheme, detectColorLevel } from './theme.js';

const ESC = String.fromCharCode(27);

vi.mock('@clack/prompts', () => {
  const cancel = Symbol('clack:cancel');
  return {
    isCancel: (value: unknown) => value === cancel,
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => cancel),
    text: vi.fn(async () => 'typed'),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    })),
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

  it('keeps an unknown top-level command at the documented exit 1', () => {
    expect(exitCodeForParseError('commander.unknownCommand', 1)).toBe(
      EXIT_FAILED,
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
    expect(rich.warning('x')).toContain('38;2;255;122;46');
    expect(rich.muted('x')).toContain('38;2;128;128;128');
    expect(rich.code('x')).toContain('38;2;244;244;244');
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

  it('colours the prefix only with a coloured theme', () => {
    const chunks: string[] = [];
    const logger = createLogger({
      write: (chunk) => chunks.push(chunk),
      theme: createCliTheme('truecolor'),
    });
    logger.error('x');
    expect(chunks[0]).toContain(ESC);
    expect(chunks[0]).toContain('error:');
    expect(chunks[0]?.endsWith(' x\n')).toBe(true);
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

  it('pads a right-aligned last column', () => {
    expect(
      renderTable([['1'], ['100']], [{ header: 'N', align: 'right' }]),
    ).toBe('  N\n  1\n100');
  });

  it('renders a box-drawn table when fancy', () => {
    const out = renderTable(rows, columns, {
      fancy: true,
      theme: createCliTheme('none'),
    });
    expect(out).toContain('┌');
    expect(out).toContain('│ bbbb │');
    expect(out).toContain('second');
    expect(renderTable(rows, columns, { fancy: true })).toContain('NAME');
  });
});

describe('prompts', () => {
  it('canPrompt needs both TTYs and no --json', () => {
    expect(canPrompt({ stdinTTY: true, stdoutTTY: true })).toBe(true);
    expect(canPrompt({ stdinTTY: false, stdoutTTY: true })).toBe(false);
    expect(canPrompt({ stdinTTY: true, stdoutTTY: false })).toBe(false);
    expect(canPrompt({ stdinTTY: true, stdoutTTY: true, json: true })).toBe(
      false,
    );
  });

  it('non-interactive prompts answer the declared value without prompting', async () => {
    const clack = await import('@clack/prompts');
    vi.mocked(clack.confirm).mockClear();
    expect(
      await promptConfirm({
        message: 'q',
        interactive: false,
        nonInteractive: false,
      }),
    ).toBe(false);
    expect(
      await promptSelect({
        message: 'q',
        interactive: false,
        nonInteractive: 'a',
        choices: [{ value: 'a' }],
      }),
    ).toBe('a');
    expect(
      await promptText({
        message: 'q',
        interactive: false,
        nonInteractive: '',
      }),
    ).toBe('');
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('interactive prompts return the answer, cancellation is null', async () => {
    expect(
      await promptConfirm({
        message: 'q',
        interactive: true,
        nonInteractive: false,
      }),
    ).toBe(true);
    expect(
      await promptSelect({
        message: 'q',
        interactive: true,
        nonInteractive: 'a',
        choices: [{ value: 'a', label: 'A', hint: 'h' }, { value: 'b' }],
      }),
    ).toBeNull();
    expect(
      await promptText({
        message: 'q',
        interactive: true,
        nonInteractive: '',
        placeholder: 'p',
      }),
    ).toBe('typed');
  });

  it('a non-interactive spinner is a silent no-op', async () => {
    const clack = await import('@clack/prompts');
    vi.mocked(clack.spinner).mockClear();
    const s = startSpinner('working', { interactive: false });
    s.update('x');
    s.stop('done');
    s.fail('nope');
    expect(clack.spinner).not.toHaveBeenCalled();
    const live = startSpinner('working', { interactive: true });
    live.update('y');
    live.stop('ok');
    live.fail('bad');
    expect(clack.spinner).toHaveBeenCalledTimes(1);
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
