import type { TokenReader } from './lexer.js';
import { nextPlainToken, nextShellToken } from './lexer.js';

// git push / remote mutation in ANY command segment: the
// verb is matched after a command-position boundary (start, `|;&`,
// newline, whitespace, a subshell paren — `$(git push)` included — `/`
// (`/usr/bin/git push`), a quote (`bash -c 'git push'`), a
// backslash (`\git push`), a backtick or a `!` — `-c alias.p='!git push'`) and
// after any run of git global
// options (`-C <dir>`, `-c <k=v>`, `--git-dir=…`, `--work-tree …`,
// `--no-pager`, …, an argument may be quoted: `git -C "my dir" push`) — so
// `ls; git push`, `cd x && git push` and `git -C . push` all raise. The word
// must be exactly `git` followed by whitespace: `mygit push`, `digit push`
// and `git-lfs push` never raise. A push named inside a quoted argument
// (`echo "git push later"`) raises too: the literal scan cannot see
// quotes, and an over-trigger is an ask, never a silent grant.
//
// The option run is walked token by token, never by one regex: a repeated
// alternation (`--namespace` as an option OR as the previous option's
// argument) backtracks exponentially (34 repeats stall for seconds), and this
// scan runs before EVERY bash call. Walking is
// a two-state automaton (expecting an option-or-verb / expecting an option
// argument) and the states already explored at a token are remembered across
// every `git` occurrence, so the whole scan is linear in the command.
//
// Words are read TWICE, and either reading reaching `push` raises: quote-aware
// (a quoted option argument is one word, a backslash escapes the next
// character outside single quotes) and plain whitespace-split (the reading the
// original regex had). The quote-aware one catches `git -C "my dir" push`; the
// plain one is the safety net for shell syntax the tokenizer misreads —
// `git -c user.name=O\'Brien push # it's fine` reads `'` as an opening quote
// only when the backslash is ignored. The plain walk is exactly the original
// regex's language, so this only ever widens what raises (fail toward asking);
// the over-trigger it keeps is the original's: a quoted option argument that
// merely contains the word (`git -c "a push" status`) still reads as a push.
const GIT_WORD = /(^|[|;&\s(/'"\\`!])git(?=\s)/gi;
const GIT_ARG_OPTION = /^-c$/i;
// Attached short options: `-C<path>` and `-cname=val` are
// complete in one word — unlike bare `-c`/`-C` they consume nothing more.
const GIT_ATTACHED_SHORT = /^-[cC][\s\S]+$/;
const GIT_FLAG = /^(?:-p|--[a-z][a-z-]*)$/i;
const GIT_VALUE_OPTION =
  /^--(?:git-dir|work-tree|namespace|exec-path|config-env)$/i;
const GIT_VALUE_ASSIGNED =
  /^--(?:git-dir|work-tree|namespace|exec-path|config-env)=[\s\S]+$/i;
const GIT_PUSH_VERB = /^push\b/i;
const GIT_REMOTE_VERB = /^remote$/i;
const GIT_REMOTE_ACTION = /^(?:add|set-url|remove|rename)\b/i;
const EXPECT_OPTION = 1;
const EXPECT_ARGUMENT = 2;

function gitVerbFollows(
  command: string,
  from: number,
  explored: Map<number, number>,
  read: TokenReader,
): boolean {
  let states = EXPECT_OPTION;
  let position = from;
  for (;;) {
    const token = read(command, position);
    if (token === undefined) return false;
    const seen = explored.get(token.start) ?? 0;
    // Everything reachable from these states here was already walked by an
    // earlier `git` — and it did not accept, or the scan would have stopped.
    states &= ~seen;
    if (states === 0) return false;
    explored.set(token.start, seen | states);
    let next = 0;
    if ((states & EXPECT_OPTION) !== 0) {
      if (GIT_PUSH_VERB.test(token.text)) return true;
      if (GIT_REMOTE_VERB.test(token.text)) {
        const action = read(command, token.end);
        if (action !== undefined && GIT_REMOTE_ACTION.test(action.text)) {
          return true;
        }
      }
      if (GIT_ARG_OPTION.test(token.text)) next |= EXPECT_ARGUMENT;
      // `-C <dir>` — the regex flag was case-insensitive, so `-C` is `-c`.
      if (
        GIT_FLAG.test(token.text) ||
        GIT_VALUE_ASSIGNED.test(token.text) ||
        GIT_ATTACHED_SHORT.test(token.text)
      ) {
        next |= EXPECT_OPTION;
      }
      // A value option may take the next word or stand alone.
      if (GIT_VALUE_OPTION.test(token.text)) next |= EXPECT_ARGUMENT;
    }
    if ((states & EXPECT_ARGUMENT) !== 0) next |= EXPECT_OPTION;
    if (next === 0) return false;
    states = next;
    position = token.end;
  }
}

export function gitPushOrRemoteMutation(command: string): boolean {
  const quoted = new Map<number, number>();
  const plain = new Map<number, number>();
  for (const origin of command.matchAll(GIT_WORD)) {
    const from = origin.index + origin[0].length;
    if (
      gitVerbFollows(command, from, quoted, nextShellToken) ||
      gitVerbFollows(command, from, plain, nextPlainToken)
    ) {
      return true;
    }
  }
  return false;
}

// `git config` that MUTATES: `git config core.hooksPath …`
// rewrites `.git/config` with no file-write target, so the write-target
// detectors never fire — only the settle drift check reports it
// afterwards. Reads (`--get`, `--list`, a bare single-name lookup) stay
// quiet; anything that writes — a set with a value, `--add`, `--unset`
// and friends, `--edit`, a scoped write via `--file` — raises. Same
// two-reader walk as the push detector (quote-aware plus plain
// whitespace-split), linear in the command, failing toward asking.
const GIT_CONFIG_VERB = /^config$/i;
// Display modifiers only: `--show-origin`/`--show-scope`
// neither read nor write, so `git config --show-origin <name> <value>`
// counts positionals and raises while `--show-origin --get <name>` and a
// bare `--show-origin <name>` stay quiet.
const GIT_CONFIG_READ =
  /^(--get|--get-all|--get-regexp|--list|-l|--get-urlmatch|--get-color|--get-colorbool)$/i;
const GIT_CONFIG_WRITE =
  /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit)$/i;
const GIT_CONFIG_VALUE_OPTION = /^--file$/i;
const GIT_CONFIG_FLAG = /^(--[a-z][a-z-]*(=[\s\S]*)?|-[a-z])$/i;

function configMutationFollows(
  command: string,
  from: number,
  explored: Set<number>,
  read: TokenReader,
): boolean {
  let position = from;
  let subcommand = false;
  let readOnly = false;
  let positionals = 0;
  for (;;) {
    const token = read(command, position);
    if (token === undefined) break;
    position = token.end;
    const text = token.text;
    if (!subcommand) {
      // Linear-time memo (same scheme as the push detector): every token
      // an earlier `git` evaluated in pre-subcommand mode evaluates the
      // same way again, so revisiting one ends this walk — the earlier
      // walk already determined what follows from here.
      if (explored.has(token.start)) return false;
      explored.add(token.start);
      // Global options before the subcommand: `-c`/`-C` and the value
      // options consume their argument; anything else flag-shaped skips.
      if (GIT_ARG_OPTION.test(text) || GIT_VALUE_OPTION.test(text)) {
        const value = read(command, position);
        if (value === undefined) return false;
        position = value.end;
        continue;
      }
      if (
        GIT_FLAG.test(text) ||
        GIT_VALUE_ASSIGNED.test(text) ||
        GIT_ATTACHED_SHORT.test(text)
      )
        continue;
      if (GIT_CONFIG_VERB.test(text)) {
        subcommand = true;
        continue;
      }
      return false;
    }
    if (GIT_CONFIG_WRITE.test(text)) return true;
    if (GIT_CONFIG_READ.test(text)) {
      readOnly = true;
      continue;
    }
    if (GIT_CONFIG_VALUE_OPTION.test(text)) {
      const value = read(command, position);
      if (value === undefined) break;
      position = value.end;
      continue;
    }
    if (GIT_CONFIG_FLAG.test(text)) continue;
    positionals += 1;
  }
  if (!subcommand) return false;
  if (readOnly) return false;
  // `git config <name>` reads one value; `git config <name> <value>`
  // (scope flags aside) writes it.
  return positionals >= 2;
}

export function gitConfigMutation(command: string): boolean {
  const quoted = new Set<number>();
  const plain = new Set<number>();
  for (const origin of command.matchAll(GIT_WORD)) {
    const from = origin.index + origin[0].length;
    if (
      configMutationFollows(command, from, quoted, nextShellToken) ||
      configMutationFollows(command, from, plain, nextPlainToken)
    ) {
      return true;
    }
  }
  return false;
}
