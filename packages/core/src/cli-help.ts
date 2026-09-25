// The `--help` convention (issue #100; §78): every shipped command answers
// `--help` (or `-h`) by printing exactly its own usage line and exiting 0.
//
// One implementation, not seven: before this, `--help` variously exited 0
// with unrelated output, exited 1, exited 2 as an unknown flag, or was not
// handled at all. Handlers call `answerHelp` as their first statement and
// return its result when it is not null — so the help path can never be
// reached after (or swallowed by) argv validation.
//
// Usage ERRORS keep their own exit codes: this module answers the help
// request only. `kubic <command>` with a bad flag still fails exactly as
// documented on the CLI pages.
//
// Lives in core because both @kubic/host and @kubic/eval own command
// handlers and core is the only package both may import (dep-lint).
// Imports nothing, holds no state.

export const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// Exit code for a help request. §78 has no separate help code: a help
// request is a successful invocation, so it shares the success code.
export const HELP_EXIT_OK = 0;

export function wantsHelp(args: readonly string[]): boolean {
  return args.some((arg) => HELP_FLAGS.includes(arg));
}

// Returns HELP_EXIT_OK after printing `usageLine` when the argv asks for
// help, or null when it does not (the caller keeps parsing).
export function answerHelp(
  args: readonly string[],
  out: (line: string) => void,
  usageLine: string,
): number | null {
  if (!wantsHelp(args)) return null;
  out(usageLine);
  return HELP_EXIT_OK;
}
