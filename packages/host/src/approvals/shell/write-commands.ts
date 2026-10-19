import { commandLead, commandWord } from '@kubic/agent/lane/interceptors';
import {
  nextShellToken,
  REDIRECT_WORD,
  shellUnquote,
  substitutionSpans,
} from './lexer.js';
import { parseOptions } from './options.js';
import { WRITE_RULES } from './writer-rules.js';

// The paths a shell command writes, by the writer table (writer-rules.ts).
// The command is the one a segment runs, past reserved words, assignments and
// wrappers (`sudo touch`, `env X=1 sed -i`, `xargs chmod`), and a command run
// by find's -exec family adds the paths find walks. Segments are split the way
// the shell splits them — at `|`, `;`, `&`, a line break, `(`, a backtick and
// the closer of a `$(…)` span, never inside quotes — and within a segment a
// comment and every redirection (`2>/dev/null`, `> out`) are dropped before
// arguments are read, so a trailing redirect cannot move a destination.
// Lexical like every shell detector here: paths that come from input (xargs,
// a file list, a variable) and writes through an interpreter (`bash -c`,
// `python3 -c`) are not seen.

export interface ShellWrite {
  /** The path as the shell reads it: quotes and escapes off. */
  readonly path: string;
  /** Where its command's segment starts: the cd trail is read there. */
  readonly at: number;
  /** A delete (`rm`, `rmdir`, `find -delete`), not a write. */
  readonly removal: boolean;
}

interface Writes {
  readonly paths: readonly string[];
  readonly removal: boolean;
}

const REMOVALS = new Set(['rm', 'rmdir']);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_FILE_ACTIONS = new Set(['-fprint', '-fprint0', '-fls', '-fprintf']);
const FIND_EXEC_END = new Set([';', '+']);
// How deep `find -exec find -exec …` is followed.
const MAX_FIND_NESTING = 4;

// find writes the files its -fprint family names, deletes what it walks on
// `-delete`, and hands what it walks to every writer its -exec family runs.
function findWrites(args: readonly string[], depth: number): Writes[] {
  let index = 0;
  while (index < args.length) {
    const text = shellUnquote(args[index] ?? '');
    if (text === '-D') index += 2;
    else if (/^-(?:[HLP]|O\d*)$/.test(text)) index += 1;
    else break;
  }
  const roots: string[] = [];
  for (; index < args.length; index += 1) {
    const text = shellUnquote(args[index] ?? '');
    if (text.startsWith('-') || text === '(' || text === '!') break;
    roots.push(args[index] ?? '');
  }
  const found: Writes[] = [];
  for (; index < args.length; index += 1) {
    const text = shellUnquote(args[index] ?? '');
    if (FIND_FILE_ACTIONS.has(text)) {
      found.push({ paths: args.slice(index + 1, index + 2), removal: false });
      index += 1;
    } else if (text === '-delete') {
      found.push({ paths: roots, removal: true });
    } else if (FIND_EXEC_ACTIONS.has(text)) {
      let end = index + 1;
      while (
        end < args.length &&
        !FIND_EXEC_END.has(shellUnquote(args[end] ?? ''))
      ) {
        end += 1;
      }
      for (const writes of commandWrites(args.slice(index + 1, end), depth)) {
        found.push(writes, { paths: roots, removal: writes.removal });
      }
      index = end;
    }
  }
  return found;
}

// A segment's words with its comment and its redirections dropped: a word
// starting with `#` opens a comment to the end of the line, and a
// redirection operator standing alone takes the next word as its target.
function operandsOf(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word.startsWith('#')) break;
    const redirect = REDIRECT_WORD.exec(word);
    if (redirect !== null) {
      if (redirect[0].length === word.length) index += 1;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

// What the command in a segment's words writes, by the table.
function commandWrites(words: readonly string[], depth = 0): Writes[] {
  const lead = commandLead(words);
  if (lead === undefined || lead === 'unknown') return [];
  const verb = commandWord(words[lead.index] ?? '');
  const args = operandsOf(words.slice(lead.index + 1));
  if (REMOVALS.has(verb)) {
    return [{ paths: parseOptions(args, {}).positionals, removal: true }];
  }
  if (verb === 'find') {
    return depth < MAX_FIND_NESTING ? findWrites(args, depth + 1) : [];
  }
  const rule = WRITE_RULES.get(verb);
  return rule === undefined ? [] : [{ paths: rule(args), removal: false }];
}

// The command segments, split the way the shell splits them: at `|`, `;`,
// `&`, a line break, a `(`, a backtick and a `$(…)` span's closer — never
// inside single quotes, and inside double quotes only where a substitution
// starts.
function commandSegments(
  command: string,
  closers: ReadonlySet<number>,
): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let start = 0;
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    const substitution =
      char === '`' ||
      (char === '(' && (quote === null || command[index - 1] === '$'));
    const breaks =
      substitution ||
      closers.has(index) ||
      (quote === null && /[|;&\n\r]/.test(char ?? ''));
    if (breaks) {
      segments.push([start, index]);
      start = index + 1;
      quote = null;
    } else if (quote === '"') {
      if (char === '"') quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    }
  }
  segments.push([start, command.length]);
  return segments;
}

function wordsOf(segment: string): string[] {
  const words: string[] = [];
  for (
    let token = nextShellToken(segment, 0);
    token !== undefined;
    token = nextShellToken(segment, token.end)
  ) {
    words.push(token.text);
  }
  return words;
}

/** Every path a bash command writes or deletes, by the writer table. */
export function shellWrites(command: string): ShellWrite[] {
  const closers = new Set(
    substitutionSpans(command).map((span) => span.closer),
  );
  const found: ShellWrite[] = [];
  for (const [start, end] of commandSegments(command, closers)) {
    for (const writes of commandWrites(wordsOf(command.slice(start, end)))) {
      for (const raw of writes.paths) {
        const path = shellUnquote(raw);
        if (path === '' || path === '-') continue;
        found.push({ path, at: start, removal: writes.removal });
      }
    }
  }
  return found;
}
