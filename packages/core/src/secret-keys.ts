// The one secret-key classifier (issue #359; §3.8, §36.1). The worker spawn
// env (worker/src/lifecycle/env.ts), its debug-log redaction and the
// trajectory exporter all classify env keys through THIS function, so a key
// one of them treats as secret can never be written in the clear by another.

export const REDACTED_ENV_VALUE = '<redacted>';

const SECRET_SUFFIXES = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'CREDENTIALS'];

// Anthropic workload identity federation (issue #402; pi-ai 0.99.2). The
// names carry none of SECRET_SUFFIXES' endings — the identity token is a
// FILE path and the ids end in _ID — yet the block IS the credential: the
// SDK exchanges the file's token for an access token, and the rule and
// organization ids are half that exchange. A worker's shell that learned the
// token file path could replay the exchange exactly as the provider does,
// so all five are secret by name rather than by shape.
const FEDERATION_SECRET_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
]);

export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  // Grant-derived keys are secrets by provenance: every role credential env
  // output lives under KUBIC_ROLE_<ROLE>_, so the whole namespace is secret
  // instead of guessing from the suffix (a grant named `session` carries a
  // secret but matches no SECRET_SUFFIXES entry).
  if (upper.startsWith('KUBIC_ROLE_')) return true;
  if (FEDERATION_SECRET_KEYS.has(upper)) return true;
  return SECRET_SUFFIXES.some(
    (suffix) => upper === suffix || upper.endsWith(`_${suffix}`),
  );
}

// Every key kept, every secret-classified value replaced.
export function redactSecretEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretEnvKey(key) ? REDACTED_ENV_VALUE : value;
  }
  return out;
}
