import { shellUnquote } from './lexer.js';

// A command's options and positional arguments, read the getopt way, for the
// writer table: short options cluster (`-sSLo out`), `--` ends the options,
// and an option with a value takes the rest of its cluster or the next word.

export interface OptionSpec {
  /** Short options that take a value: the rest of the cluster, or the next word. */
  readonly short?: string;
  /** Short options whose value is attached only (`-i.bak`), possibly empty. */
  readonly attached?: string;
  /** Long options that take a value: `--name=value` or `--name value`. */
  readonly long?: readonly string[];
}

export interface Parsed {
  readonly positionals: readonly string[];
  /** Values by short letter or long name. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** Every option given, with or without a value. */
  readonly given: ReadonlySet<string>;
}

/** A list of option names written as one space-separated string. */
export function names(list: string): readonly string[] {
  return list.split(' ');
}

export function parseOptions(
  args: readonly string[],
  spec: OptionSpec,
): Parsed {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const given = new Set<string>();
  const add = (name: string, value: string | undefined): void => {
    given.add(name);
    if (value === undefined) return;
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? '';
    const text = shellUnquote(raw);
    if (text === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      const name = text.slice(2, equals < 0 ? undefined : equals);
      if (equals >= 0) add(name, text.slice(equals + 1));
      else if (spec.long?.includes(name) === true) {
        add(name, args[index + 1]);
        index += 1;
      } else given.add(name);
      continue;
    }
    if (!text.startsWith('-') || text.length === 1) {
      positionals.push(raw);
      continue;
    }
    for (let at = 1; at < text.length; at += 1) {
      const letter = text[at] ?? '';
      const rest = text.slice(at + 1);
      if (spec.attached?.includes(letter) === true) {
        add(letter, rest);
        break;
      }
      if (spec.short?.includes(letter) === true) {
        if (rest !== '') add(letter, rest);
        else {
          add(letter, args[index + 1]);
          index += 1;
        }
        break;
      }
      given.add(letter);
    }
  }
  return { positionals, values, given };
}

export function valuesOf(parsed: Parsed, ...keys: string[]): string[] {
  return keys.flatMap((key) => parsed.values.get(key) ?? []);
}

export function lastOf(items: readonly string[]): string[] {
  const item = items[items.length - 1];
  return item === undefined ? [] : [item];
}
