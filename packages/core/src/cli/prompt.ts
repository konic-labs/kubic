// Interactive prompts and spinners outside the TUI (@clack/prompts).
//
// The rule: a prompt NEVER runs when the invocation is non-interactive —
// stdin or stdout not a TTY, or `--json` (a machine consumer). Every
// helper takes the explicit `interactive` switch and a documented
// non-interactive answer, so a script or CI run can never hang on a
// question nobody can see. A cancelled prompt (Ctrl-C / Esc) resolves to
// `null`; the caller decides the exit.

import { confirm, isCancel, select, spinner, text } from '@clack/prompts';

export interface Interactivity {
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly json?: boolean;
}

export function canPrompt(state: Interactivity): boolean {
  return state.stdinTTY && state.stdoutTTY && state.json !== true;
}

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
  const answer = await confirm({
    message: options.message,
    initialValue: options.initial ?? false,
  });
  return isCancel(answer) ? null : answer;
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label?: string;
  readonly hint?: string;
}

export async function promptSelect<T extends string>(
  options: PromptBase<T> & { readonly choices: readonly Choice<T>[] },
): Promise<T | null> {
  if (!options.interactive) return options.nonInteractive;
  const answer = await select<string>({
    message: options.message,
    options: options.choices.map((choice) => ({
      value: choice.value,
      ...(choice.label === undefined ? {} : { label: choice.label }),
      ...(choice.hint === undefined ? {} : { hint: choice.hint }),
    })),
  });
  if (isCancel(answer)) return null;
  // Every option value is a T, so the chosen one is too.
  return (
    options.choices.find((choice) => choice.value === answer)?.value ?? null
  );
}

export async function promptText(
  options: PromptBase<string> & { readonly placeholder?: string },
): Promise<string | null> {
  if (!options.interactive) return options.nonInteractive;
  const answer = await text({
    message: options.message,
    ...(options.placeholder === undefined
      ? {}
      : { placeholder: options.placeholder }),
  });
  return isCancel(answer) ? null : answer;
}

export interface CliSpinner {
  readonly update: (message: string) => void;
  readonly stop: (message?: string) => void;
  readonly fail: (message?: string) => void;
}

const SILENT_SPINNER: CliSpinner = {
  update: () => {},
  stop: () => {},
  fail: () => {},
};

// A spinner on an interactive terminal; a silent no-op otherwise (a
// spinner's frames would corrupt a pipe or a `--json` document).
export function startSpinner(
  message: string,
  options: { readonly interactive: boolean },
): CliSpinner {
  if (!options.interactive) return SILENT_SPINNER;
  const s = spinner();
  s.start(message);
  return {
    update: (next) => s.message(next),
    stop: (final) => s.stop(final),
    fail: (final) => s.error(final),
  };
}
