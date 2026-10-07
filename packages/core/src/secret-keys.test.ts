// The ONE secret-key classifier (issue #359): the worker spawn env, its debug
// redaction and the trajectory exporter all ask this function, so a key the
// spawn path treats as secret can never be exported in the clear.
import { describe, expect, it } from 'vitest';
import {
  isSecretEnvKey,
  REDACTED_ENV_VALUE,
  redactSecretEnv,
} from './secret-keys.js';

describe('isSecretEnvKey', () => {
  it.each([
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'db_password',
    'AWS_SECRET',
    'GCP_CREDENTIALS',
    'TOKEN',
    'KEY',
    // Anthropic workload identity federation (issue #402; pi-ai 0.99.2):
    // the identity config reads none of the suffix rules — the token FILE
    // ends in _FILE, the ids end in _ID — so each is named explicitly.
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
    'ANTHROPIC_WORKSPACE_ID',
  ])('classifies %s as secret', (key) => {
    expect(isSecretEnvKey(key)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'KEYBOARD', 'MONKEY', 'KUBIC_MODEL', 'TOKENIZER'])(
    'leaves %s alone',
    (key) => {
      expect(isSecretEnvKey(key)).toBe(false);
    },
  );

  it('redacts only secret-classified values', () => {
    expect(
      redactSecretEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-live-123' }),
    ).toEqual({ PATH: '/bin', OPENAI_API_KEY: REDACTED_ENV_VALUE });
    expect(REDACTED_ENV_VALUE).toBe('<redacted>');
  });

  it('redacts the Anthropic federation block whole (issue #402)', () => {
    expect(
      redactSecretEnv({
        PATH: '/bin',
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_123',
        ANTHROPIC_ORGANIZATION_ID: 'org_123',
        ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/identity-token',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_123',
        ANTHROPIC_WORKSPACE_ID: 'wrkspc_123',
      }),
    ).toEqual({
      PATH: '/bin',
      ANTHROPIC_FEDERATION_RULE_ID: REDACTED_ENV_VALUE,
      ANTHROPIC_ORGANIZATION_ID: REDACTED_ENV_VALUE,
      ANTHROPIC_IDENTITY_TOKEN_FILE: REDACTED_ENV_VALUE,
      ANTHROPIC_SERVICE_ACCOUNT_ID: REDACTED_ENV_VALUE,
      ANTHROPIC_WORKSPACE_ID: REDACTED_ENV_VALUE,
    });
  });
});
