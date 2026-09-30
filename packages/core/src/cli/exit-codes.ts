// The §78 exit-code table (docs/cli/exit-codes.md) as named constants, plus
// the one mapping from a commander parse failure to a Kubic exit code.
//
// Lives in core so every command handler (host, eval, the app root) names
// the same numbers. Pure: no commander import — the mapper takes commander's
// stable `code` strings, so core stays free of the parser.

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BUDGET = 3;
export const EXIT_APPROVAL = 4;
export const EXIT_WORKSPACE = 5;
export const EXIT_PROVIDER = 6;

// A bad invocation a command detects itself (after commander parsed argv):
// throw it from an action and the program prints `error: <message>` and
// exits EXIT_USAGE instead of the catch-all EXIT_FAILED.
export class CliUsageError extends Error {
  readonly exitCode: number = EXIT_USAGE;
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// A command failure with a specific §78 code and a one-line message
// (`error: <message>`, no stack unless KUBIC_DEBUG=1).
export class CliExitError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'CliExitError';
    this.exitCode = exitCode;
  }
}

// commander's informational exits (help, version) are successes; an
// unknown top-level command keeps the documented exit 1; every other parse
// failure (unknown option, missing value, bad argument, excess operands) is
// a usage error — exit 2, never commander's default 1.
const SUCCESS_CODES = new Set(['commander.helpDisplayed', 'commander.version']);
const PARSE_ERROR_CODES = new Set([
  'commander.unknownOption',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.invalidArgument',
  'commander.invalidOptionArgument',
  'commander.excessArguments',
  'commander.conflictingOption',
]);

export function exitCodeForParseError(
  commanderCode: string,
  commanderExitCode: number,
): number {
  if (SUCCESS_CODES.has(commanderCode)) return EXIT_OK;
  // `cmd.help({ error: true })` (a group invoked without a subcommand)
  // carries exit 1; a plain `cmd.help()` carries 0.
  if (commanderCode === 'commander.help') {
    return commanderExitCode === 0 ? EXIT_OK : EXIT_USAGE;
  }
  if (commanderCode === 'commander.unknownCommand') return EXIT_FAILED;
  if (PARSE_ERROR_CODES.has(commanderCode)) return EXIT_USAGE;
  return commanderExitCode === 0 ? EXIT_OK : EXIT_FAILED;
}
