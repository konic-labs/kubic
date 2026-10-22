// The secret env-key classifier. The trajectory exporter classifies the
// environment a run used through this function, so a secret-classified
// value is never written in the clear.

/** @internal */
export const REDACTED_ENV_VALUE = '<redacted>';

const SECRET_SUFFIXES = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'CREDENTIALS'];

// Anthropic workload identity federation (pi-ai 0.99.2). The
// names carry none of SECRET_SUFFIXES' endings — the identity token is a
// FILE path and the ids end in _ID — yet the block IS the credential: the
// SDK exchanges the file's token for an access token, and the rule and
// organization ids are half that exchange. An agent's shell that learned the
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
