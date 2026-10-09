// Commander helpers the command groups share: a value rule as an argument
// parser, repeatable flags, and the examples block of a command's help.

import { InvalidArgumentError } from '@commander-js/extra-typings';

// A host value rule as a commander argument parser: its refusal becomes
// commander's `option '…' argument '…' is invalid. <reason>` (exit 2).
export function rule<T>(parse: (value: string) => T): (value: string) => T {
  return (value) => {
    try {
      return parse(value);
    } catch (error) {
      throw new InvalidArgumentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

// Repeatable value flags collect into an array, in argv order.
export function collect<T>(
  parse: (value: string) => T,
): (value: string, previous: T[]) => T[] {
  const one = rule(parse);
  return (value, previous) => [...previous, one(value)];
}

export function examples(lines: readonly string[]): string {
  return `\nExamples:\n${lines.map((line) => `  $ ${line}`).join('\n')}`;
}
