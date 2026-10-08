// What an approval dialog shows of a command.
//
// The user decides on the request, so the display is built from the SAME
// args the approval key hashes — never from the model's description and
// never silently cut. A model can pad a harmless prefix past any character
// cap and hide a destructive tail; the defence is to carry the whole command
// to every seat and to mark every shortening with what it hid.
//
// The text is made safe to display, not reinterpreted: control characters
// (ESC, BEL, …) and the bidi / zero-width / default-ignorable format
// characters that can reorder, hide or mis-measure what a terminal draws are
// shown as visible escapes (`\x1b`, `\u202e`, `\u3164`); newlines and tabs
// are kept so a multi-line command reads as its lines; secret VALUES are
// redacted, never the words around them and never anything the shell would
// execute (see redactApprovalSecrets).

import { redactSecrets } from '../../agent/src/lane/interceptors.js';

// The summary's command budget: summaries are one-line labels (trajectory,
// audit detail). The full command
// travels separately in the request's `command` field.
export const SUMMARY_COMMAND_LIMIT = 120;

// \p{Default_Ignorable_Code_Point} covers U+3164 / U+115F / U+FFA0 (Hangul
// fillers), U+00AD, variation selectors and the tag characters: pi-tui
// measures them zero columns wide but many terminals draw some of them wide,
// so a row can overflow and push the command's tail off screen.
const HIDDEN_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\p{Default_Ignorable_Code_Point}]/gu;

function visibleEscape(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = code.toString(16);
  if (code < 0x100) return `\\x${hex.padStart(2, '0')}`;
  if (code <= 0xffff) return `\\u${hex.padStart(4, '0')}`;
  return `\\u{${hex}}`;
}

function escapeHidden(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, visibleEscape);
}

const REDACTED = '[REDACTED]';

// A literal `[REDACTED]` in the command would read as a real redaction
// (`curl -d @[REDACTED] …` is a glob, not a hidden secret). It is shown with
// its opening bracket escaped, `\x5bREDACTED]`, so the marker only ever means
// "a value was hidden here".
const LITERAL_MARKER = /\[REDACTED\]/g;

// Known key shapes (sk-, AKIA…, gh?_, xox?-, a PEM header), applied in ONE
// global pass so word boundaries hold (`task-…` is not an `sk-` key, `ghost_…`
// is not a GitHub token) and the cost stays linear in the command length.
// Deliberately tighter than policy/secret-shapes.ts: that list is a
// fail-closed backstop for text that LEAVES the screen; this one only decides
// what the operator sees of the command they are approving, and it leaves out
// that list's context-free `bearer <10+ chars>` rule, which swallows prose.
const KEY_SHAPES = new RegExp(
  [
    '\\bsk-[A-Za-z0-9_-]{20,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bxox[baprs]-[A-Za-z0-9-]{10,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  ].join('|'),
  'gi',
);

// Names that mark the value next to them as a secret. A name only counts when
// it ENDS with one of these (`GITHUB_TOKEN`, `--auth-token`, `x-api-key`), so
// `--token-file` or a prose word like `secret` stay readable.
const SECRET_NAME =
  '(?:token|password|passwd|passphrase|secret(?:[-_]?access)?[-_]?key|secret|access[-_]?key|api[-_]?key|private[-_]?key)';

// What precedes a secret value. Each form fixes how the value may be
// separated from its name, because the value must be the SAME shell word as
// the name and can never be the next command word:
//   NAME=value       no whitespace at all (`SECRET_KEY= shred -u x` is an
//                    empty assignment followed by a command)
//   name: value      spaces/tabs only, at least one (`secret:/etc` is a mount
//                    and `release-token:main` a refspec, not secrets)
//   --flag value     spaces/tabs only, and the value is not another flag
//   Authorization:   the header form (with its scheme word)
// and none of them crosses a newline.
const ASSIGNED = new RegExp(`${SECRET_NAME}=`, 'gi');
const KEY_VALUE = new RegExp(`${SECRET_NAME}[ \\t]*:[ \\t]+`, 'gi');
const FLAG_OPERAND = new RegExp(
  `(?<![^\\s])--?[A-Za-z0-9_-]*${SECRET_NAME}[ \\t]+(?!-)`,
  'gi',
);
const AUTHORIZATION = /authorization[ \t]*(?::[ \t]*|=)/gi;
const BARE_BEARER = /\bbearer[ \t]+/gi;

// A user flag whose operand has the `user:password` shape (curl's `-u` /
// `--user`, its proxy twin `-U` / `--proxy-user`). The colon is required, so
// an ordinary `-u` (`cp -u a b`, `sort -u names`) stays readable; the short
// forms may be attached (`-uadmin:hunter2`, review of).
const USER_FLAG =
  /(?:^|[\s"'])(?:-u|-U)(?:[=\s]\s*)?|(?:^|[\s"'])(?:--user|--proxy-user)[=\s]\s*"?/gi;

// URL userinfo that carries a password (`https://user:pw@host`), redacted by
// a plain replace so the host stays visible; user-only userinfo
// (`ssh://git@host`) is not a secret and stays readable.
// The scheme length is BOUNDED: an unbounded `[a-z0-9+.-]*` before the
// required `://` backtracks over a long letter-run at every start position
// (quadratic — the linearity test caught it), and no real scheme is 20
// characters long.
const URL_USERINFO = /([a-z][a-z0-9+.-]{1,20}:\/\/)[^/\s@:]+:[^/\s@]+@/gi;

const AUTH_SCHEME = /(?:bearer|basic|token|digest)[ \t]+/iy;
const BARE_SCHEME = /^(?:bearer|basic|token|digest)$/i;
// A bare `bearer <credential>` outside a header counts only for a
// credential-looking word (20+ token characters mixing letters and digits), so
// `echo bearer rm -rf ~/x` keeps `rm`.
const CREDENTIAL =
  /^(?=[A-Za-z0-9\-._~+=]*\d)(?=[A-Za-z0-9\-._~+=]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9\-._~+=]{19,}$/;

// A value the shell would EXPAND — `$(…)`, `${…}`, `$NAME`, a backtick — is
// code or a reference, never a secret: it is shown verbatim. Redacting it
// (or the part of it before the `$`) would hide what actually runs.
const EXPANSION = /[$`]/;
const WORD_STOP = /[\s;&|<>()]/;

// The offset of the quote that closes the one at `open`, or -1 when it does
// not close on the same line (a quoted value never spans a newline here).
function closingQuote(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (quote === '"' && ch === '\\') {
      if (text[i + 1] === '\n') return -1;
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

// The end of the shell word that starts at `from`: plain characters and quoted
// strings up to whitespace or a shell operator. An unterminated quote ends the
// word before it. Equal to `from` when no word starts there.
function wordEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '"' || ch === "'") {
      const close = closingQuote(text, i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (WORD_STOP.test(ch)) break;
    i += 1;
  }
  return i;
}

interface ValueRule {
  readonly prefix: RegExp;
  // The header form: an authorization scheme word before the value is part of
  // the redacted credential (`Bearer abc` → the marker).
  readonly scheme?: boolean;
  // A further test on the value word.
  readonly only?: (word: string) => boolean;
}

// Replace the value that follows each match of the rule's prefix with the
// marker — the one shell word after it, unless it holds an expansion.
function redactAfter(text: string, rule: ValueRule): string {
  const { prefix } = rule;
  let out = '';
  let done = 0;
  prefix.lastIndex = 0;
  for (let hit = prefix.exec(text); hit !== null; hit = prefix.exec(text)) {
    const valueAt = hit.index + hit[0].length;
    let wordAt = valueAt;
    if (rule.scheme === true) {
      AUTH_SCHEME.lastIndex = valueAt;
      const scheme = AUTH_SCHEME.exec(text);
      if (scheme !== null) wordAt += scheme[0].length;
    }
    const end = wordEnd(text, wordAt);
    if (end === wordAt) continue;
    const word = text.slice(wordAt, end);
    if (EXPANSION.test(word)) continue;
    // `Authorization: Bearer` with nothing after it: the scheme is not a value.
    if (wordAt === valueAt && rule.scheme === true && BARE_SCHEME.test(word)) {
      continue;
    }
    if (rule.only !== undefined && !rule.only(word)) continue;
    out += text.slice(done, valueAt) + REDACTED;
    done = end;
    prefix.lastIndex = end;
  }
  return out + text.slice(done);
}

const VALUE_RULES: ReadonlyArray<ValueRule> = [
  { prefix: AUTHORIZATION, scheme: true },
  { prefix: ASSIGNED },
  { prefix: KEY_VALUE },
  { prefix: FLAG_OPERAND },
  { prefix: USER_FLAG, only: (word) => word.includes(':') },
  { prefix: BARE_BEARER, only: (word) => CREDENTIAL.test(word) },
];

// What the approval dialog redacts. The shared `redactSecrets`
// (worker interceptors) swallows the WORD after `secret`/`token`/`bearer`,
// which is right for a persisted reason but wrong here: the dialog exists so
// the operator sees what will run, and the swallowed word can be the
// destructive verb or flag. Known key shapes and secret-named values are
// replaced; every other word is left as written, and so is any value that
// carries an expansion. Display only: the approval key hashes the raw args.
function redactApprovalSecrets(command: string): string {
  let out = command
    .replace(KEY_SHAPES, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const rule of VALUE_RULES) out = redactAfter(out, rule);
  return out;
}

// The full command as the dialog shows it: secret values redacted (narrowly,
// see above), a literal `[REDACTED]` and every hidden character made visible,
// nothing cut. Only the dialog's `command` field uses this: summaries and
// everything persisted keep the broad `redactSecrets` (summarizeCommand).
export function approvalCommandText(command: string): string {
  const visible = escapeHidden(command).replace(
    LITERAL_MARKER,
    () => `\\x5bREDACTED]`,
  );
  return redactApprovalSecrets(visible);
}

// `<capability>: <command>` for summaries, shortened to `limit` characters
// with an explicit `… (+N chars)` marker — never a silent slice. Summaries
// reach the trajectory and the audit ledger, so they are redacted like block
// reasons (the broad `redactSecrets`), not like the dialog.
export function summarizeCommand(
  capability: string,
  command: string,
  limit: number = SUMMARY_COMMAND_LIMIT,
): string {
  const text = escapeHidden(redactSecrets(command));
  if (text.length <= limit) return `${capability}: ${text}`;
  return `${capability}: ${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}
