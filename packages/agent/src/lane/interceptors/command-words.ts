// The command a shell segment runs. A segment's first word is not always its
// command: the reserved words a command may follow (`then rm`, `{ rm`,
// `! rm`), `NAME=value` assignments, and the programs that run their
// arguments as a command in place (`sudo rm`, `env X=1 rm`, `nice -n 5 rm`,
// `xargs rm`) come first. Shared by the destructive matcher and the
// approval layer's write-target table, so both read the same command.

const RESERVED_WORDS = new Set([
  'if',
  'elif',
  'then',
  'do',
  'else',
  'while',
  'until',
  '{',
  '!',
]);

// Each wrapper with the options of its own that take a separate argument.
// After a wrapper, a word starting with `-` or a digit (a nice or timeout
// value) is one of its options.
const WRAPPER_ARGUMENT_OPTIONS: ReadonlyMap<string, readonly string[]> =
  new Map([
    [
      'sudo',
      ['-u', '-g', '-C', '-D', '-h', '-p', '-R', '-r', '-T', '-t', '-U'],
    ],
    ['doas', ['-u', '-C']],
    ['env', ['-u', '-C', '-P', '--unset', '--chdir']],
    ['nice', ['-n', '--adjustment']],
    ['ionice', ['-c', '-n', '-p', '-P', '-u']],
    ['timeout', ['-s', '-k', '--signal', '--kill-after']],
    ['time', ['-f', '-o', '--format', '--output']],
    ['nohup', []],
    ['command', []],
    ['builtin', []],
    ['exec', ['-a']],
    ['stdbuf', ['-i', '-o', '-e']],
    [
      'xargs',
      [
        '-a',
        '-d',
        '-E',
        '-I',
        '-L',
        '-n',
        '-P',
        '-s',
        '--arg-file',
        '--delimiter',
        '--eof',
        '--replace',
        '--max-lines',
        '--max-args',
        '--max-procs',
        '--max-chars',
        '--process-slot-var',
      ],
    ],
  ]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Words read before the command. Past the bound a caller fails closed, so a
// long run of wrappers can neither stall a scan nor hide a command behind it.
export const MAX_LEAD_WORDS = 64;

export interface CommandLead {
  /** Index of the command word among the words given. */
  readonly index: number;
  /** A wrapper on the way was xargs: the command's paths come from input. */
  readonly viaXargs: boolean;
}

// A shell word with its quotes and backslash escapes off.
function shellText(text: string): string {
  return text.replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

/**
 * A command word as the shell reads it: quotes and backslashes come off, a
 * directory is dropped (`\rm`, `'rm'` and `/bin/rm` are `rm`), and case is
 * folded, as a case-insensitive volume resolves it.
 */
export function commandWord(text: string): string {
  const plain = shellText(text);
  return plain.slice(plain.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Where the command among a segment's `words` starts. undefined when the
 * segment runs no command; 'unknown' when the lead is MAX_LEAD_WORDS words or
 * longer.
 */
export function commandLead(
  words: readonly string[],
): CommandLead | 'unknown' | undefined {
  let wrapper: readonly string[] | undefined;
  let skipArgument = false;
  let viaXargs = false;
  const bound = Math.min(words.length, MAX_LEAD_WORDS);
  for (let index = 0; index < bound; index += 1) {
    const text = shellText(words[index] ?? '');
    if (skipArgument) {
      skipArgument = false;
      continue;
    }
    if (wrapper !== undefined && /^[-\d]/.test(text)) {
      skipArgument = wrapper.includes(text);
      continue;
    }
    if (ASSIGNMENT.test(text)) continue;
    const word = commandWord(text);
    if (RESERVED_WORDS.has(word)) {
      wrapper = undefined;
      continue;
    }
    const options = WRAPPER_ARGUMENT_OPTIONS.get(word);
    if (options !== undefined) {
      wrapper = options;
      viaXargs ||= word === 'xargs';
      continue;
    }
    return { index, viaXargs };
  }
  return words.length > bound ? 'unknown' : undefined;
}
