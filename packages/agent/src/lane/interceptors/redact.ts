// Redacting secret shapes from block reasons and summaries.
import { redactSecretShapes } from '@kubic/core/secret-shapes';

// Reasons persist into the trajectory, so commands and raw errors are
// truncated and secret-shaped values redacted before they become blocks.
export function redactReason(value: string): string {
  const short = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return redactSecrets(short);
}

// Approval summaries, block reasons, the trajectory and the audit ledger all
// pass through this redactor, so it composes the shared @kubic/core shape
// table on top of the inline rules. It is deliberately at least as strong as
// the host's display redactor (approvals/display.ts): the display one keeps
// prose readable because the operator must see what will run, this one may
// over-redact because what it writes is persisted.
const REDACTED = '[REDACTED]';

// A credential-shaped word: 10+ token characters, the same threshold the
// shared table's bearer rule uses, so a scheme word before prose (`bearer of
// bad news`) stays readable while a short token still hits the keyword pass.
const CREDENTIAL_WORD = '[A-Za-z0-9][A-Za-z0-9\\-._~+=]{9,}';

// The FULL credential after an authorization scheme. The scheme
// word is kept so the reader sees what was hidden; `Authorization: Bearer
// sk-live-123` redacts the whole credential, not only `Bearer`.
const AUTH_CREDENTIAL = new RegExp(
  [
    // Header form: `Authorization[:=] [scheme] <credential>` — the separator
    // and the scheme are both optional, so the space-separated
    // `Authorization hunter2` and `--authorization hunter2` forms are covered
    // too (review of: dropping `authorization` from the keyword pass had
    // left the no-colon spelling in the clear).
    String.raw`(\bauthorization\s*[:=]?\s*(?:(?:bearer|basic|token|digest)\s+)?)\S+`,
    // Bare scheme form: `Bearer <credential>` / `Basic <credential>`.
    `((?:^|[\\s"'=(])(?:bearer|basic|token|digest)\\s+)(${CREDENTIAL_WORD})`,
  ].join('|'),
  'gi',
);

// URL userinfo that carries a password (`https://user:pw@host`). User-only
// userinfo (`ssh://git@host`) is not a secret and stays readable. The scheme
// length is BOUNDED: an unbounded `[a-z0-9+.-]*` before the required `://`
// backtracks over a long letter-run at every start position (quadratic), and
// no real scheme is 20 characters long.
const URL_USERINFO = /([a-z][a-z0-9+.-]{1,20}:\/\/)[^/\s@:]+:[^/\s@]+@/gi;

// A user flag whose operand has the `user:password` shape: curl's `-u` /
// `--user` and its proxy twin `-U` / `--proxy-user`. The short forms may be
// attached (`-uadmin:hunter2`); the long forms need `=` or a
// space. The colon is required, so an unrelated `-u` (`cp -u a b`,
// `sort -u names`) is left alone.
const USER_FLAG_CREDENTIAL =
  /((?:^|[\s"'])(?:-u|-U)(?:[=\s]\s*)?|(?:^|[\s"'])(?:--user|--proxy-user)[=\s]\s*"?)[^\s"']*:[^\s"']*/gi;

// Secret-named values: `--token abc`, `SECRET_KEY=x`, `password: y`, and a
// short bare `bearer abc` (the authorization header and the long bare
// schemes are handled above).
const KEYWORD_SECRET =
  /((?:token|password|passwd|secret|api[-_]?key|bearer|private[-_]?key)\s*(?:[=:]\s*|\s+))\S+/gi;

// The redaction half alone, never truncating: an approval
// dialog must show the whole command, so it redacts without cutting.
export function redactSecrets(value: string): string {
  return redactSecretShapes(
    value
      .replace(AUTH_CREDENTIAL, '$1$2[REDACTED]')
      .replace(URL_USERINFO, `$1${REDACTED}@`)
      .replace(USER_FLAG_CREDENTIAL, `$1${REDACTED}`)
      .replace(KEYWORD_SECRET, `$1${REDACTED}`),
  );
}
