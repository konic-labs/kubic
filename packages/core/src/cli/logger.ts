// Leveled diagnostics for CLI commands (consola). The contract:
//
// - every level writes to STDERR — stdout is reserved for a command's
//   data (its report, table, or `--json` document), so a `--json` run's
//   stdout stays pure JSON however chatty the logger is;
// - one line per message, `<level>: <message>` — `error: …` is the same
//   one-line shape the root catch-all prints (docs/cli/exit-codes.md);
// - `debug` is silent unless KUBIC_DEBUG=1 (or a command's own
//   `--debug`, where it declares one: run, workers);
// - on a colour terminal the level prefix is a status mark (✕ ▲ ℹ ✓); otherwise
//   (a pipe, NO_COLOR, `--json`) it is the plain
//   `<level>:` word.

import { formatWithOptions } from 'node:util';
import {
  type ConsolaInstance,
  type ConsolaReporter,
  createConsola,
  type LogObject,
} from 'consola/core';
import { type CliTheme, createCliTheme } from './theme.js';

export interface LoggerOptions {
  // Where every level goes (process.stderr in production).
  readonly write: (chunk: string) => void;
  readonly debug?: boolean;
  readonly theme?: CliTheme;
}

export interface CliLogger {
  readonly error: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly info: (message: string) => void;
  readonly success: (message: string) => void;
  readonly debug: (message: string) => void;
  // The underlying consola instance (mockTypes / pause in tests).
  readonly consola: ConsolaInstance;
}

// consola levels: 0 error, 1 warn, 3 info/success, 4 debug.
const INFO_LEVEL = 3;
const DEBUG_LEVEL = 4;

// KUBIC_DEBUG=1 is the documented stack-trace opt-in (exit-codes.md); the
// same switch turns on debug logs.
export function debugEnabled(
  flags: { readonly debug?: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return flags.debug === true || env.KUBIC_DEBUG === '1';
}

function lineReporter(
  write: (chunk: string) => void,
  theme: CliTheme,
): ConsolaReporter {
  // On a colour terminal the level is a status mark (the 06
  // glyphs); plain output keeps the `<level>:` words scripts grep for.
  const ui = theme.ui;
  const prefix = (type: LogObject['type']): string => {
    const debugType =
      type === 'debug' || type === 'trace' || type === 'verbose';
    if (!theme.enabled) {
      if (type === 'error' || type === 'fatal') return 'error:';
      if (type === 'warn') return 'warn:';
      if (type === 'success') return 'ok:';
      return debugType ? 'debug:' : 'info:';
    }
    if (type === 'error' || type === 'fatal') return ui.fg('err')('✕');
    if (type === 'warn') return ui.fg('warn')('▲');
    if (type === 'success') return ui.fg('ok')('✓');
    if (debugType) return ui.fg('fg2')('debug:');
    return ui.fg('info')('ℹ');
  };
  return {
    log: (logObj) => {
      const message = formatWithOptions({ colors: false }, ...logObj.args);
      write(`${prefix(logObj.type)} ${message}\n`);
    },
  };
}

/** @internal */
export function createLogger(options: LoggerOptions): CliLogger {
  const theme = options.theme ?? createCliTheme('none');
  const instance = createConsola({
    level: options.debug === true ? DEBUG_LEVEL : INFO_LEVEL,
    reporters: [lineReporter(options.write, theme)],
    // Identical consecutive lines are real output (two failing checks can
    // share a message) — never collapse them.
    throttle: 0,
  });
  return {
    error: (message) => instance.error(message),
    warn: (message) => instance.warn(message),
    info: (message) => instance.info(message),
    success: (message) => instance.success(message),
    debug: (message) => instance.debug(message),
    consola: instance,
  };
}

// A logger over a LINE channel (`console.error`-style: it appends its own
// newline), the shape command handlers receive as `err`. The logger's
// chunk writer ends every message in '\n'; the channel adds it back.
export function createLineLogger(
  line: (text: string) => void,
  options: Omit<LoggerOptions, 'write'> = {},
): CliLogger {
  return createLogger({
    ...options,
    write: (chunk) => line(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk),
  });
}
