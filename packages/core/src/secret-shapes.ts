// Shared secret-shape backstop (issue #57 fix cycle 1; §36 broker, §60 audit).
// Lives in @kubic/core since issue #192 so the WORKER redactor (approval
// summaries, block reasons, the mailbox ask JSON) composes the same table the
// HOST backstop (audit, policy, ledger) uses — the dependency direction is
// core ← host/worker, so this is the only place both may share it.
// Fail-closed detection for live secret material that was never listed in a
// caller-supplied secrets inventory: sk-style keys, AWS access keys, GitHub
// and Slack-shaped tokens, PEM blocks, and bearer tokens. Fixtures in tests
// carry a 'faux' marker and stay inert — shapes below never match them unless
// combined with a real-looking prefix run (e.g. 'sk-faux-test-key-0001').
// Faux-only, zero network.
// Case-transform bypass note (fix cycle 2): the sk-/gh-/xox- prefixes match
// case-insensitively, so uppercasing never evades any call site. Fix cycle 3
// extends the same treatment to the remaining shapes: the bearer scheme is
// matched case-insensitively per RFC 7235 §2.1 (BEARER/bEaReR/BeArEr all
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
  '\\b[Ss][Kk]-[A-Za-z0-9_\\-]{8,}', // case-insensitive prefix (fix cycle 2)
  // AWS access key id: AKIA + 16 alphanumerics, case-insensitive prefix and
  // material (fix cycle 3) so lowercasing never evades any call site.
  '\\b[Aa][Kk][Ii][Aa][0-9A-Za-z]{16}\\b',
  // GitHub-shaped tokens: ghp_/gho_/ghu_/ghs_/ghr_/gh_ + material.
  '\\b[Gg][Hh][a-zA-Z]*_[A-Za-z0-9]{8,}', // case-insensitive prefix (fix cycle 2)
  // Slack-shaped tokens: xox[bpasr]- + material.
  '\\b[Xx][Oo][Xx][BbPpAaSsRr]?-[A-Za-z0-9\\-]{8,}', // case-insensitive prefix (fix cycle 2)
  // PEM private-key blocks, case-insensitive header (fix cycle 3).
  '-----[Bb][Ee][Gg][Ii][Nn] [A-Za-z0-9 ]*[Pp][Rr][Ii][Vv][Aa][Tt][Ee] [Kk][Ee][Yy]-----',
  // Bearer tokens on the wire, case-insensitive scheme per RFC 7235 §2.1
  // (fix cycle 3): BEARER/bEaReR/BeArEr never evade any call site.
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

// The secret-shaped substrings found in the text (each at most once,
// in encounter order). Never returns the full text, only the matches.
export function findSecretShapes(text: string): string[] {
  const found: string[] = [];
  for (const source of SHAPE_SOURCES) {
    for (const match of text.matchAll(patternFor(source))) {
      const hit = match[0];
      if (!found.includes(hit)) found.push(hit);
    }
  }
  return found;
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
