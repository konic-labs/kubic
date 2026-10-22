// Shared secret-shape backstop. Lives in @kubic/core so the lane redactor
// (approval summaries, block reasons) composes the same table the host
// backstop (audit, policy, ledger) uses — the dependency direction is
// core ← host/agent, so this is the only place both may share it.
// Fail-closed detection for live secret material that was never listed in a
// caller-supplied secrets inventory: sk-style keys, AWS access keys, GitHub
// and Slack-shaped tokens, PEM blocks, and bearer tokens. Fixtures in tests
// carry a 'faux' marker and stay inert — shapes below never match them unless
// combined with a real-looking prefix run (e.g. 'sk-faux-test-key-0001').
// Faux-only, zero network.
// Case-transform bypass note: the sk-/gh-/xox- prefixes match
// case-insensitively, so uppercasing never evades any call site. Fix
// extends the same treatment to the remaining shapes: the bearer scheme is
// matched case-insensitively per RFC 7235 (BEARER/bEaReR/BeArEr all
// hit), as are the AKIA prefix and the PEM header line.
// Residual limit (by design, not enforced): material split across separately
// scanned strings so no single scan carries the full shape is not reassembled
// here. Likewise the leading \b word boundary is deliberate: an embedded run
// like 'xxSK-…' evades by design to avoid false positives on tokens such as
// 'task-xxx' — only free-standing shapes are refused.

const SHAPE_SOURCES: readonly string[] = [
  // OpenAI-style keys: sk- plus a long run (covers sk-live-*, sk-test-*,
  // sk-proj-*). The {8,} run keeps faux markers like '«redacted:sk-…»'
  // (ellipsis is outside the class) from matching.
  '\\b[Ss][Kk]-[A-Za-z0-9_\\-]{8,}', // case-insensitive prefix
  // AWS access key id: AKIA + 16 alphanumerics, case-insensitive prefix and
  // material so lowercasing never evades any call site.
  '\\b[Aa][Kk][Ii][Aa][0-9A-Za-z]{16}\\b',
  // GitHub-shaped tokens: ghp_/gho_/ghu_/ghs_/ghr_/gh_ + material.
  '\\b[Gg][Hh][a-zA-Z]*_[A-Za-z0-9]{8,}', // case-insensitive prefix
  // Slack-shaped tokens: xox[bpasr]- + material.
  '\\b[Xx][Oo][Xx][BbPpAaSsRr]?-[A-Za-z0-9\\-]{8,}', // case-insensitive prefix
  // PEM private-key blocks, case-insensitive header.
  '-----[Bb][Ee][Gg][Ii][Nn] [A-Za-z0-9 ]*[Pp][Rr][Ii][Vv][Aa][Tt][Ee] [Kk][Ee][Yy]-----',
  // Bearer tokens on the wire, case-insensitive scheme per RFC 7235:
  // BEARER/bEaReR/BeArEr never evade any call site.
  '\\b[Bb][Ee][Aa][Rr][Ee][Rr]\\s+[A-Za-z0-9\\-._~+/=]{10,}',
];

const SHAPE_PATTERN = new RegExp(`(?:${SHAPE_SOURCES.join('|')})`);

function patternFor(source: string): RegExp {
  return new RegExp(`(?:${source})`, 'g');
}

export const REDACTED_SECRET = '[redacted-secret]';

// True when the text carries any secret-shaped substring.
export function containsSecretShape(text: string): boolean {
  // Fresh exec state per call: the shared pattern is non-global.
  return SHAPE_PATTERN.test(text);
}

// Replace every secret-shaped substring with a fixed placeholder. Used to
// keep error messages fail-closed: they name the failure, never the secret.
export function redactSecretShapes(text: string): string {
  let out = text;
  for (const source of SHAPE_SOURCES) {
    out = out.replace(patternFor(source), REDACTED_SECRET);
  }
  return out;
}

// Approval summaries, block reasons, the trajectory, the audit ledger and
// dataset exports all pass through this redactor, so it composes the shared
// shape table on top of the inline rules. It is deliberately at least as strong as
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
