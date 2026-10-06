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

export interface KeyChoice<T extends string> {
  /** The key that answers (`y`); matched without case. */
  readonly key: string;
  readonly label: string;
  readonly value: T;
}

// The input a one-key prompt reads: a TTY stream in raw mode.
export interface KeyPromptInput {
  setRawMode?(mode: boolean): unknown;
  readonly isRaw?: boolean;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface KeyPromptIo {
  readonly input: KeyPromptInput;
  readonly write: (text: string) => void;
}

// One keystroke from a short list (issue #462, the trust question): the
// key IS the answer — no Enter, no arrows; any other key is ignored. Same
// contract as promptConfirm: never prompts off a TTY, `null` on Ctrl-C or
// Esc. The caller renders the question (`message`, keys included); raw
// mode is restored however the prompt ends.
export async function promptKey<T extends string>(
  options: PromptBase<T> & {
    readonly choices: readonly KeyChoice<T>[];
    readonly io?: KeyPromptIo;
  },
): Promise<T | null> {
  if (!options.interactive) return options.nonInteractive;
  const io: KeyPromptIo = options.io ?? {
    input: process.stdin as unknown as KeyPromptInput,
    write: (text) => {
      process.stdout.write(text);
    },
  };
  io.write(`${options.message}\n`);
  const wasRaw = io.input.isRaw === true;
  io.input.setRawMode?.(true);
  io.input.resume();
  return new Promise<T | null>((resolve) => {
    const finish = (answer: T | null): void => {
      io.input.off('data', onData);
      io.input.setRawMode?.(wasRaw);
      io.input.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === '\u0003' || char === '\u001b') {
          finish(null);
          return;
        }
        const choice = options.choices.find(
          (candidate) => candidate.key.toLowerCase() === char.toLowerCase(),
        );
        if (choice !== undefined) {
          finish(choice.value);
          return;
        }
      }
    };
    io.input.on('data', onData);
  });
}
