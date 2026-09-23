// Spawn env allowlist §3.8 + role-scoped creds §36.3 (issue #42).
// Pure: the child sees exactly the allowlisted base plus its own role
// grant — never the parent's secrets, never a sibling role's token.
// Debug lines go through redactEnvForLog so secrets never hit §50 output.

export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'CI',
  'NO_COLOR',
  'CLICOLOR',
  'KUBIC_MODEL',
  'KUBIC_DEBUG',
];

const KUBIC_PREFIX = 'KUBIC_';

const SECRET_SUFFIXES = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'CREDENTIALS'];

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_SUFFIXES.some(
    (suffix) => upper === suffix || upper.endsWith(`_${suffix}`),
  );
}

export function filterSpawnEnv(
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if ((ENV_ALLOWLIST as readonly string[]).includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function roleCredentialEnv(
  role: string,
  grant: Record<string, string>,
): Record<string, string> {
  const prefix = `KUBIC_ROLE_${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(grant)) {
    if (key.startsWith(KUBIC_PREFIX)) {
      out[key] = value;
      continue;
    }
    const name = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    out[`${prefix}${name}`] = value;
  }
  return out;
}

export function buildSpawnEnv(
  base: Record<string, string>,
  role: string,
  grant: Record<string, string>,
): Record<string, string> {
  return { ...filterSpawnEnv(base), ...roleCredentialEnv(role, grant) };
}

export function redactEnvForLog(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretKey(key) ? '<redacted>' : value;
  }
  return out;
}
