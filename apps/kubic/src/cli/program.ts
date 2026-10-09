// The Kubic commander program: one parser for every command, with Kubic's
// contracts layered over commander's defaults.
//
// - exitOverride: commander never calls process.exit — every parse outcome
//   becomes an exit code through core's `exitCodeForParseError` (usage
//   errors → 2, help/version → 0), and the root decides when to exit.
// - configureOutput: help/version go to the stdout line channel, parse
//   errors to stderr as commander's one-line `error: …`.
// - enablePositionalOptions: root options (`-V`, `-h`) only count before
//   the command name, so `kubic doctor -V` reaches doctor untouched.
// - no implicit `help` command: `kubic help` stays an unknown command.
// - actions throwing CliUsageError / CliExitError print `error: <message>`
//   and exit with the carried code; anything else propagates to the
//   root's catch-all in ../main.ts (stack only under KUBIC_DEBUG=1).
// - an action that runs must report its result (CommandContext.finish); one
//   that returns without it is an internal error (exit 1), never a silent 0.
// - no "(Did you mean …?)" line: a usage error is exactly one stderr line.
// - a value option never swallows a following `--flag` (or the `--`
//   terminator) as its value: `--session --json` is a missing value
//   (exit 2 before any runner), as the pre-commander parser had it. A
//   value that starts with `--` is still accepted in the attached forms
//   (`--session=--x`, `-p--x`).

import {
  Command,
  CommanderError,
  Help,
  type Option,
} from '@commander-js/extra-typings';
import {
  CliExitError,
  CliUsageError,
  EXIT_FAILED,
  type ExitCode,
  exitCodeForParseError,
} from '@kubic/core/cli/exit-codes';
import { errorBlock } from '@kubic/core/cli/kit';
import type { CliTheme } from '@kubic/core/cli/theme';
import { shellQuote } from '@kubic/host/run';
import type { KubicProgram } from './context.js';

export interface ProgramIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface ProgramOptions {
  // The full `kubic --version` line (core/license.ts formatVersionLine).
  readonly versionLine: string;
  // The root help text (`kubic --help`); its plain form is pinned by the
  // binary contract.
  readonly rootHelp: string;
  // The stdout theme. When it is coloured, subcommand help is
  // styled (titles, terms) through commander's style hooks; absent or plain
  // keeps commander's text byte-for-byte.
  readonly helpTheme?: CliTheme;
  // The stderr theme. When it is coloured, a usage error
  // (unknown option, missing value) is an error block; plain otherwise.
  readonly errorTheme?: CliTheme;
}

// commander hands whole chunks ending in '\n'; the line channels add their
// own newline (console.log in production).
function toLines(write: (line: string) => void): (chunk: string) => void {
  return (chunk) => write(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
}

// Commander's help style hooks over the shared tokens. Titles
// (`Usage:`, `Options:`) muted and bold, the command line bold, option and
// argument terms secondary; descriptions keep the default text colour.
function helpStyles(theme: CliTheme | undefined): {
  styleTitle?: (text: string) => string;
  styleCommandText?: (text: string) => string;
  styleOptionTerm?: (text: string) => string;
  styleArgumentTerm?: (text: string) => string;
  styleSubcommandTerm?: (text: string) => string;
} {
  if (theme === undefined || !theme.enabled) return {};
  const ui = theme.ui;
  return {
    styleTitle: ui.style({ fg: 'fg2', bold: true }),
    styleCommandText: ui.style({ fg: 'fg0', bold: true }),
    styleOptionTerm: ui.fg('fg1'),
    styleArgumentTerm: ui.fg('fg1'),
    styleSubcommandTerm: ui.fg('fg1'),
  };
}

export function createKubicProgram(
  io: ProgramIo,
  options: ProgramOptions,
): KubicProgram {
  const program = new Command('kubic');
  program
    .version(options.versionLine, '-V, --version', 'print the version')
    .helpOption('-h, --help', 'print usage')
    .helpCommand(false)
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: toLines(io.out),
      writeErr: toLines(io.err),
      outputError: (message, write) => {
        const theme = options.errorTheme;
        if (theme === undefined || !theme.enabled) {
          write(message);
          return;
        }
        const text = message.trimEnd().replace(/^error: /u, '');
        const lines = errorBlock(theme, {
          message: text,
          hints: ['`--help` lists the options'],
        });
        write(`${lines.join('\n')}\n`);
      },
      // Help on stdout keeps its styles only when the stdout theme is
      // coloured; help written to stderr (a usage error) is always plain.
      getOutHasColors: () => options.helpTheme?.enabled === true,
      getErrHasColors: () => false,
    })
    .configureHelp({
      // The root answers with the grouped root help; subcommands keep
      // commander's generated help, styled on a coloured terminal.
      formatHelp: (cmd, helper) =>
        cmd.parent === null
          ? `${options.rootHelp}\n`
          : Help.prototype.formatHelp.call(helper, cmd, helper),
      ...helpStyles(options.helpTheme),
    });
  return program;
}

// A value rule over commander's binding, not a second parser: commander
// already bound the next token to the option; this is the one program-wide
// place that refuses a bound value that is really a flag (or `--`).
const FLAG_LIKE = /^--/;

// The first required-value option in `argv` whose value would be taken
// from a separate token that starts with `--` (a flag, or the terminator).
// Scanning stops at the first bare `--` that is not such a value: what
// follows it is operands.
function swallowedFlag(
  command: { readonly options: readonly Option[] },
  argv: readonly string[],
): string | undefined {
  const valued = command.options.filter((option) => option.required);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') return undefined;
    const option = valued.find(
      (candidate) => candidate.long === token || candidate.short === token,
    );
    if (option === undefined) continue;
    const next = argv[i + 1];
    if (next === undefined) return undefined;
    if (FLAG_LIKE.test(next)) {
      const base = `option '${option.flags}' argument missing`;
      if (next === '--') return base;
      const attached =
        option.long === undefined
          ? `${option.short}${next}`
          : `${option.long}=${shellQuote(next)}`;
      return `${base} (${JSON.stringify(next)} looks like a flag; write a value that starts with '--' as ${attached})`;
    }
    i += 1;
  }
  return undefined;
}

// What an invocation reports once it has run: its exit code, and whether the
// command that ran reported a result through CommandContext.finish.
interface ProgramExit {
  readonly code: () => ExitCode;
  readonly finished: () => boolean;
}

// Runs the program over `argv` (the arguments after `node kubic`) and
// resolves the invocation's exit code.
export async function runKubicProgram(
  program: KubicProgram,
  argv: readonly string[],
  io: ProgramIo,
  exit: ProgramExit,
): Promise<ExitCode> {
  program.hook('preAction', (_root, action) => {
    const problem = swallowedFlag(action, argv);
    if (problem !== undefined) throw new CliUsageError(problem);
  });
  // Runs only after an action returned normally, so an action that threw
  // never reaches it. A command that returned without a result is a bug in
  // its registrar: report it rather than exit 0.
  program.hook('postAction', (_root, action) => {
    if (!exit.finished()) {
      throw new CliExitError(
        EXIT_FAILED,
        `internal error: command '${action.name()}' finished without a result`,
      );
    }
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exit.code();
  } catch (error) {
    if (error instanceof CommanderError) {
      return exitCodeForParseError(error.code, error.exitCode);
    }
    if (error instanceof CliUsageError || error instanceof CliExitError) {
      io.err(`error: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}
