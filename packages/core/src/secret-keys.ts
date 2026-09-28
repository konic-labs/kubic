// The one secret-key classifier (issue #359; §3.8, §36.1). The worker spawn
// env (worker/src/lifecycle/env.ts), its debug-log redaction and the
// trajectory exporter all classify env keys through THIS function, so a key
// one of them treats as secret can never be written in the clear by another.

export const REDACTED_ENV_VALUE = '<redacted>';

const SECRET_SUFFIXES = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'CREDENTIALS'];

export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  // Grant-derived keys are secrets by provenance: every role credential env
  // output lives under KUBIC_ROLE_<ROLE>_, so the whole namespace is secret
  // instead of guessing from the suffix (a grant named `session` carries a
  // secret but matches no SECRET_SUFFIXES entry).
  if (upper.startsWith('KUBIC_ROLE_')) return true;
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
