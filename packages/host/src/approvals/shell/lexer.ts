const WHITESPACE_CHAR = /\s/;

interface ShellToken {
  text: string;
  start: number;
  end: number;
}

export type TokenReader = (
  command: string,
  from: number,
) => ShellToken | undefined;

// The next whitespace-delimited word at or after `from`, quote-aware: a
// balanced `"…"` or `'…'` run belongs to the word even when it holds spaces,
// a backslash outside single quotes escapes the next character (`\'`, `\ `,
// and `\"` inside double quotes), and a quote with no closer is an ordinary
// character. Stateless from a token start, so a position always tokenizes the
// same way whichever `git` reached it.
export function nextShellToken(
  command: string,
  from: number,
): ShellToken | undefined {
  let start = from;
  while (start < command.length && WHITESPACE_CHAR.test(command[start] ?? '')) {
    start += 1;
  }
  if (start >= command.length) return undefined;
  let end = start;
  while (end < command.length && !WHITESPACE_CHAR.test(command[end] ?? '')) {
    const char = command[end];
    if (char === '\\') {
      end = Math.min(end + 2, command.length);
    } else if (char === "'") {
      const close = command.indexOf("'", end + 1);
      end = close < 0 ? end + 1 : close + 1;
    } else if (char === '"') {
      end = afterDoubleQuoted(command, end);
    } else {
      end += 1;
    }
  }
  return { text: command.slice(start, end), start, end };
}

// The index after the double-quoted run opening at `open` (a backslash inside
// escapes the next character), or after the lone quote when nothing closes it.
function afterDoubleQuoted(command: string, open: number): number {
  for (let index = open + 1; index < command.length; index += 1) {
    if (command[index] === '\\') index += 1;
    else if (command[index] === '"') return index + 1;
  }
  return open + 1;
}

// The original reading: a word is a run of non-whitespace, quotes and
// backslashes included.
export function nextPlainToken(
  command: string,
  from: number,
): ShellToken | undefined {
  let start = from;
  while (start < command.length && WHITESPACE_CHAR.test(command[start] ?? '')) {
    start += 1;
  }
  if (start >= command.length) return undefined;
  let end = start;
  while (end < command.length && !WHITESPACE_CHAR.test(command[end] ?? '')) {
    end += 1;
  }
  return { text: command.slice(start, end), start, end };
}
// Shell redirection into an absolute target is a write by another name —
// `echo x > /etc/cron.d/x` must raise outside-write like the write tool.
// EVERY redirect operator in the command is scanned, within a
// segment and across `;`/`&&`/`||`/`|`/newline segments, so an inside
// redirect first cannot hide `> /etc/cron.d/x` after it. Operators:
// `>`, `>>`, fd-prefixed `2>`/`1>>` (the digit is just text before the
// operator), `&>`, `&>>`, clobber `>|`, and `>&` — whose target is an fd
// duplication (`2>&1`, `>&-`) and skipped when it is a digit run or `-`,
// and a file otherwise (`>& out.txt`). The target is the next token up to
// whitespace or a `|;&<>` operator character.
export const REDIRECT = /(&>>?|>\||>>?&?)[ \t]*([^\s|;&<>]*)/g;
export const FD_DUPLICATION = /^(\d+|-)$/;
// A `tee`, `cp`, `mv` or `install` word ANYWHERE in a command — quoted
// context included, so `bash -c 'cp a /etc/x'` is seen — has the last word of
// its segment checked as a write target (the last-argument heuristic: flags
// and sources come first). Every command segment is scanned (a `|;&` or a
// line break cannot be crossed), so `cp a /etc/b && echo done` cannot hide
// the write just because it is not the tail segment. The writer table
// (write-commands.ts) reads the same commands by their options for the
// command a segment runs — `cp -t /etc a b`, every target of `tee /etc/x
// a.txt` — so this scan only ever adds what the table cannot see.
export const TEE_TARGET = /\btee\b([^|;&\n\r]*)/gi;
export const COPY_TARGET = /\b(cp|mv|install)\b([^|;&\n\r]*)/gi;
// Command indirection: a destructive/network verb inside
// `$(…)`, backticks, or after `eval` raises the UNDERLYING capability
// instead of staying silent. The matcher layer documents indirection as
// unenforceable for its guards — detection is cheaper than enforcement
// and the ask is the safety net. `$(…)` is collected with a bounded
// literal `$(…)`/`)` pairing scan (nested substitutions included), and every wrapper
// form unwraps to a fixpoint: `eval $(rm -rf /)`, `echo $(echo $(rm -rf
// /))`, and backtick-wrapped `$(rm -rf /)` all raise, not only the
// single-level `$(rm -rf /)` the first cut handled. Stated bound: nesting
// at 2x MAX_UNWRAP_DEPTH stays unraised — the unmatched-opener
// markers the scan pushes past the cap still consume closers, which
// doubles the effective threshold (31 nesting levels raise, 32 stay
// silent; pinned in the detector tests). A depth cap, never a fabricated
// unwrap.
const MAX_UNWRAP_DEPTH = 16;
const EVAL_SEGMENT = /\beval\s+[^\n|;&]*/g;
const BACKTICK_INDIRECT = /`[^`]*`/g;

// A recorded `$(…)` region: the raw text plus the index of the `)` that
// closed it. The closer index is what lets target extraction trim exactly
// the substitution glue off a LIFTED token — and never a plain one.
interface SubstitutionSpan {
  text: string;
  closer: number;
}

// All `$(…)` regions the scan pairs, in one linear pass — inner regions
// included, so `echo $(echo $(rm -rf /))` yields both `$(rm -rf /)` and
// the outer region. The scan is literal, not a shell parser (a bare `(`
// inside is ordinary text). A `$(` that never closes is skipped; openers
// past MAX_UNWRAP_DEPTH are marked unmatched instead of pairing with some
// inner `)`. Those markers still occupy stack slots and consume closers,
// so past the cap pairing shifts (a recorded region can pair an opener
// with a later `)`) and the effective nesting threshold is ~2x
// MAX_UNWRAP_DEPTH — measured: 31 nesting levels still unwrap, 32 stay
// silent, pinned in the detector tests. Every recorded region is a
// `$(`…`)` substring of the command; the scan never invents text and never
// loops.
export function substitutionSpans(command: string): SubstitutionSpan[] {
  const spans: SubstitutionSpan[] = [];
  const openers: number[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '$' && command[index + 1] === '(') {
      openers.push(openers.length < MAX_UNWRAP_DEPTH ? index : -1);
      index += 1;
    } else if (command[index] === ')' && openers.length > 0) {
      const start = openers.pop() ?? -1;
      if (start >= 0) {
        spans.push({ text: command.slice(start, index + 1), closer: index });
      }
    }
  }
  return spans;
}

// Every wrapper cue in the raw command: literal `$(…)` spans (nested ones
// included), `eval` segments, and backtick spans.
export function indirectCues(
  command: string,
  spans: SubstitutionSpan[],
): string[] {
  return [
    ...spans.map((span) => span.text),
    ...(command.match(EVAL_SEGMENT) ?? []),
    ...(command.match(BACKTICK_INDIRECT) ?? []),
  ];
}

// The classifiers anchor on command text (`rm` at a command start), so
// every wrapper must come off before they see the payload: `$(rm -rf /)`
// and backtick-wrapped `rm -rf /` classify as `rm -rf /`, and
// `eval "rm -rf /"` likewise. Unwrapping repeats to a fixpoint — each step
// strictly shortens the payload, and MAX_UNWRAP_DEPTH bounds the walk — so
// `eval $(rm -rf /)` and backtick-wrapped `$(rm -rf /)` come off through
// every layer.
export function unwrapIndirection(nested: string): string {
  let inner = nested.trim();
  for (let step = 0; step < MAX_UNWRAP_DEPTH; step += 1) {
    const before = inner;
    if (inner.startsWith('$(') && inner.endsWith(')')) {
      inner = inner.slice(2, -1).trim();
    } else if (inner.startsWith('`') && inner.endsWith('`')) {
      inner = inner.slice(1, -1).trim();
    } else if (/^eval\s+/i.test(inner)) {
      inner = inner.replace(/^eval\s+/i, '').trim();
    } else {
      // Quote wrappers only (`eval "rm -rf /"`, `eval "$(rm -rf /)"`).
      // Deliberately quote-only: the full stripQuotes runs AFTER the loop,
      // so a lifted trailing `)` can never be mistaken for a wrapper
      // delimiter mid-unwrap.
      inner = inner.replace(/^['"]+|['"]+$/g, '');
    }
    if (inner === before) break;
  }
  return stripQuotes(inner);
}

// Shell quoting only: strip a run of surrounding quotes. Targets and
// unwrapped payloads arrive raw from the command string, and quotes are
// shell syntax — the path named is what is inside them (`> "/etc/cron.d/x"`
// names `/etc/cron.d/x`, `tee '/etc/x'` names `/etc/x`).
//
// No delimiter trimming happens here. A trailing `)`/`]` on a PLAIN token
// is path text: `tee '/work)'` names the literal sibling path `/work)`, and
// trimming it would silently widen what counts as inside (an outside → inside
// flip turns an ask into a silent grant). The ONLY delimiter trim in this
// module is the span-closer trim in targetToken, scoped to tokens actually
// lifted out of a `$(…)` span.
export function stripQuotes(target: string): string {
  return target.replace(/^['"]+/, '').replace(/['"]+$/, '');
}

// The write target of a detector segment: its last word (last-argument
// heuristic; segmentEnd is the segment's absolute end index in the raw
// command, so token characters tie back to command positions). Words are read
// quote-aware (`"/etc/my dir/x"` is one word), a word starting with `#` opens
// a comment that ends the reading, and a redirection is not an argument —
// `cp a /etc/x 2>/dev/null` names `/etc/x`, and an operator standing alone
// takes its target word with it. Quotes and backslash escapes always come
// off, wherever they sit in the word (`".."/x`, `.."/x"`, `\../x` all name
// `../x`; — the same shell reading the control-plane targets get). A trailing
// delimiter comes off ONLY when it is the closing `)` of a `$(…)` span the
// word was lifted from — `$(cp a /work)` names `/work`, because that `)` is
// substitution syntax, not path text — and then exactly the recorded closer
// comes off, never a character that merely looks like one. Plain words are
// never trimmed: `tee /work]` names `/work]` and still raises. The outside
// check itself stays path-boundary aware (`/work-evil` is not `/work`): quote
// stripping narrows a word to the path it names, and the closer trim removes
// substitution glue only.
export function targetToken(
  segment: string,
  segmentEnd: number,
  spanClosers: ReadonlySet<number>,
): string {
  let last: ShellToken | undefined;
  for (
    let token = nextShellToken(segment, 0);
    token !== undefined;
    token = nextShellToken(segment, token.end)
  ) {
    if (token.text.startsWith('#')) break;
    const redirect = REDIRECT_WORD.exec(token.text);
    if (redirect === null) {
      last = token;
    } else if (redirect[0].length === token.text.length) {
      token = nextShellToken(segment, token.end) ?? token;
    }
  }
  if (last === undefined) return '';
  const end = segmentEnd - segment.length + last.end;
  let cut = 0;
  while (cut < last.text.length && spanClosers.has(end - 1 - cut)) {
    cut += 1;
  }
  return shellUnquote(last.text.slice(0, last.text.length - cut));
}

// A path the shell would expand from the home directory — `~`, `$HOME`,
// `${HOME}` or `${HOME:-…}`, alone or followed by `/…` — as the part below home
// ('' for home itself); undefined for anything else (`~root`, `$HOMEDIR`,
// `$HOME2`, a plain path). One rule for the control-plane class and for `cd`
// tracking, so `$HOME/.kubic` can never be read differently from `~/.kubic`.
const HOME_PREFIXED = /^(?:~|\$HOME|\$\{HOME(?::?-[^}]*)?\})(?:\/([\s\S]*))?$/;
export function homeRelative(path: string): string | undefined {
  const match = HOME_PREFIXED.exec(path);
  return match === null ? undefined : (match[1] ?? '');
}

// The shell's CURRENT directory — `~+`, `$PWD`, `${PWD}` — as the relative path
// below it ('' for the directory itself); undefined for anything else. The
// previous directory (`~-`, `$OLDPWD`) is not knowable from the text.
const PWD_PREFIXED = /^(?:~\+|\$PWD|\$\{PWD(?::?-[^}]*)?\})(?:\/([\s\S]*))?$/;
export const OLDPWD_PREFIXED = /^(?:~-|\$OLDPWD|\$\{OLDPWD\})(?:\/|$)/;
export function pwdRelative(path: string): string | undefined {
  const match = PWD_PREFIXED.exec(path);
  return match === null ? undefined : (match[1] ?? '');
}

// A tiny bounded memo for per-command scans: the same bash command is read by
// the control-plane refusal and by trigger detection, and an 8000-target
// command made each of them re-scan every earlier `cd`.
const MEMO_LIMIT = 8;
export function memoised<T>(
  cache: Map<string, T>,
  key: string,
  compute: () => T,
): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (cache.size >= MEMO_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

// Every redirect target in a command (see writeTargets), with the operator's
// `&` when it has one: `>&` names a file unless the target is an fd
// duplication (`2>&1`, `>&-` — skipped by the caller), `&>`/`&>>` are plain
// redirects. Process substitutions are not file targets and are skipped.
export const ALL_REDIRECT_TARGETS = />{1,2}([|&])?\s*([^\s|;&<>()]+)/g;
// rm/mv operands: the whole argument run of the segment (flags are dropped by
// the caller). Sources are included because removing or moving state is a
// write to it.
export const REMOVE_MOVE_OPERANDS = /\b(rm|mv)\b([^|;&\n\r]*)/gi;

// A bash token as the shell reads it: quotes come off wherever they sit
// (`".kubic"/roles`, `.k"ub"ic`) and a backslash escapes the next character
// (`\.kubic`). Over-approximate on purpose — a quote is never part of a path
// worth telling apart from the state dir, and a wrong read only asks.
export function shellUnquote(token: string): string {
  return token.replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

// A redirection word: `>`, `>>`, `2>`, `&>`, `>&`, `>|`, `<`, `<<`, `<&`, `N>&M`…
// When the operator stands alone the NEXT word is its target.
export const REDIRECT_WORD = /^(?:&>>?|\d*(?:>>|>&|>\||>|<&|<>|<<<|<<|<))/;
