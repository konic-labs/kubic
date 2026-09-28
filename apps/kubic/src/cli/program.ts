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

import { Command, CommanderError, Help } from '@commander-js/extra-typings';
import {
  CliExitError,
  CliUsageError,
  exitCodeForParseError,
} from '../../../../packages/core/src/cli/exit-codes.js';
import type { KubicProgram } from './context.js';

export interface ProgramIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface ProgramOptions {
  // The full `kubic --version` line (core/license.ts formatVersionLine).
  readonly versionLine: string;
  // The root help text (`kubic --help`), pinned by the binary contract.
  readonly rootHelp: string;
}

// commander hands whole chunks ending in '\n'; the line channels add their
// own newline (console.log in production).
function toLines(write: (line: string) => void): (chunk: string) => void {
  return (chunk) => write(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
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
    .configureOutput({
      writeOut: toLines(io.out),
      writeErr: toLines(io.err),
      outputError: (message, write) => write(message),
    })
    .configureHelp({
      // The root answers with the pinned usage line; subcommands keep
      // commander's generated help.
      formatHelp: (cmd, helper) =>
        cmd.parent === null
          ? `${options.rootHelp}\n`
          : Help.prototype.formatHelp.call(helper, cmd, helper),
    });
  return program;
}

// Runs the program over `argv` (the arguments after `node kubic`) and
// resolves the invocation's exit code.
export async function runKubicProgram(
  program: KubicProgram,
  argv: readonly string[],
  io: ProgramIo,
  exit: { readonly code: () => number },
): Promise<number> {
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
