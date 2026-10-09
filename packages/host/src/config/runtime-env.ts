// The KUBIC_* environment overrides the runtime config honours, and their
// parsers. A malformed value is refused by name.

import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { ConfigError } from './errors.js';
import { configKey } from './schema.js';

// Documented environment overrides, applied above every file layer and below
// an explicit CLI flag. The names are part of the CLI contract; the config
// keys' own come from the schema.
export const RUNTIME_ENV_OVERRIDES = {
  model: envOf('model', 'provider'),
  modelThinking: envOf('model', 'thinking'),
  approvalsRoute: envOf('approvals', 'route'),
  journalRetentionDays: envOf('journal', 'retentionDays'),
  trustProject: 'KUBIC_TRUST_PROJECT',
} as const;

function envOf(section: string, name: string): string {
  const env = configKey(section, name).env;
  if (env === undefined) throw new Error(`'${section}.${name}' has no env`);
  return env;
}

export function parseEnvModel(
  raw: string,
  envName: string,
): { provider: string; id: string } {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ConfigError(
      `${envName} must be 'provider/id' (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

export function parseEnvRetention(raw: string, envName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `${envName} must be a non-negative integer of days (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return Number(raw);
}

export function parseEnvRoute(
  raw: string,
  envName: string,
): 'ask-user' | 'deny' {
  if (raw !== 'ask-user' && raw !== 'deny') {
    throw new ConfigError(
      `${envName} must be 'ask-user' or 'deny' (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return raw;
}

export function envFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}
