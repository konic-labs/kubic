// The secret scanner data loss prevention runs over what Kubic persists and,
// when the policy asks, over tool output before the model reads it. It finds:
//
//   - PEM private-key blocks, whole (a block cut short is redacted to the
//     end of the text);
//   - the key shapes of the shared table (secret-shapes.ts): sk- keys, AWS
//     access key ids, GitHub and Slack tokens, bearer tokens;
//   - secret-named assignments whose value looks random: `API_KEY=…`,
//     `"client_secret": "…"`, `password: …` — the value must be at least 12
//     characters, mix at least two kinds of character and carry enough
//     entropy, so `password: string` in code stays readable;
//   - passwords in URL userinfo and Basic credentials.
//
// Each finding becomes `[redacted-secret]`, a token that is safe inside JSON
// text, so the scanner can run over a JSON line without breaking it: the
// patterns never span a quote or a backslash. Escaped newlines (`\n` inside
// JSON) count as line breaks for the PEM block. Pure: no I/O.

import { REDACTED_SECRET, redactSecretShapes } from './secret-shapes.js';

export interface SecretScan {
  readonly text: string;
  // How many values were redacted.
  readonly found: number;
}

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const SECRET_NAME =
  '(?:api[-_]?key|apikey|secret(?:[-_]?key)?|client[-_]?secret|access[-_]?key(?:[-_]?id)?|private[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|password|passwd|pwd|credentials?)';

// `<name><sep><value>`: the name may sit inside a longer identifier
// (`AWS_SECRET_ACCESS_KEY`), the separator is `=`, `:` or `=>` with optional
// quotes (escaped ones too) around it.
const ASSIGNMENT = new RegExp(
  `(\\b[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*\\\\?["']?\\s*(?:=>|[:=])\\s*\\\\?["']?)([A-Za-z0-9_\\-+/=.~]{12,})`,
  'gi',
);

const URL_PASSWORD =
  /([a-z][a-z0-9+.-]{1,20}:\/\/[^/\s:@"'\\]+:)([^/\s@"'\\]+)(@)/gi;

const BASIC_CREDENTIAL = /(\bbasic\s+)([A-Za-z0-9+/]{12,}={0,2})/gi;

// Shannon entropy in bits per character.
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

// Random-looking: at least two of lower, upper, digit, symbol, and
// enough entropy that it is not a word or a repeated pattern.
function looksRandom(value: string): boolean {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) =>
    kind.test(value),
  ).length;
  return kinds >= 2 && entropy(value) >= 3;
}

function countOf(text: string): number {
  return text.split(REDACTED_SECRET).length - 1;
}

export function scanSecrets(text: string): SecretScan {
  const before = countOf(text);
  let out = text.replace(PEM_BLOCK, REDACTED_SECRET);
  out = redactSecretShapes(out);
  out = out.replace(ASSIGNMENT, (whole, head: string, value: string) =>
    looksRandom(value) && !value.includes(REDACTED_SECRET)
      ? `${head}${REDACTED_SECRET}`
      : whole,
  );
  out = out.replace(URL_PASSWORD, `$1${REDACTED_SECRET}$3`);
  out = out.replace(BASIC_CREDENTIAL, `$1${REDACTED_SECRET}`);
  return { text: out, found: countOf(out) - before };
}
