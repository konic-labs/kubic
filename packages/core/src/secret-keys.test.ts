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
    'KUBIC_ROLE_IMPLEMENTER_SESSION',
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
});
