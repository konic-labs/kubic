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

export interface SelectChoice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

// One choice from a list (issue #451, `kubic setup`). Same contract as
// promptConfirm: never prompts off a TTY, `null` on cancel.
export async function promptSelect<T extends string>(
  options: PromptBase<T> & {
    readonly choices: readonly SelectChoice<T>[];
    readonly initial?: T;
  },
): Promise<T | null> {
  if (!options.interactive) return options.nonInteractive;
  const { isCancel, select } = await import('@clack/prompts');
  const answer = await select<T>({
    message: options.message,
    options: options.choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.hint === undefined ? {} : { hint: choice.hint }),
    })) as Parameters<typeof select<T>>[0]['options'],
    ...(options.initial === undefined ? {} : { initialValue: options.initial }),
    // A provider can list hundreds of models: scroll a window of ten.
    maxItems: 10,
  });
  return isCancel(answer) ? null : (answer as T);
}

// The frame of an interactive flow (`┌ title` … `└ message`), drawn by
// @clack/prompts so the questions between them line up.
export async function promptFrame(): Promise<{
  readonly intro: (title: string) => void;
  readonly step: (message: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
}> {
  const clack = await import('@clack/prompts');
  return {
    intro: (title) => clack.intro(title),
    step: (message) => clack.log.step(message),
    outro: (message) => clack.outro(message),
    cancel: (message) => clack.cancel(message),
  };
}
