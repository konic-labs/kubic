// Interactive prompts outside the TUI (@clack/prompts).
//
// The rule: a prompt NEVER runs when the invocation is non-interactive —
// stdin or stdout not a TTY, or `--json` (a machine consumer). Every
// helper takes the explicit `interactive` switch and a documented
// non-interactive answer, so a script or CI run can never hang on a
// question nobody can see. A cancelled prompt (Ctrl-C / Esc) resolves to
// `null`; the caller decides the exit.
//
// @clack/prompts loads on the first interactive prompt only: every other
// invocation (scripts, CI, `--version`) skips its import cost.

export interface PromptBase<T> {
  readonly message: string;
  readonly interactive: boolean;
  // The answer when prompting is not allowed. Required on purpose: there
  // is no implicit default for a question nobody saw.
  readonly nonInteractive: T;
}

export async function promptConfirm(
  options: PromptBase<boolean> & { readonly initial?: boolean },
): Promise<boolean | null> {
  if (!options.interactive) return options.nonInteractive;
  const { confirm, isCancel } = await import('@clack/prompts');
  const answer = await confirm({
    message: options.message,
    initialValue: options.initial ?? false,
  });
  return isCancel(answer) ? null : answer;
}
