// Spawn env allowlist §3.8 + role-scoped creds §36.3 (issue #42):
// the child sees exactly the allowlist plus its own role grant —
// never the parent's secrets, never a sibling role's token.
import { describe, expect, it } from 'vitest';
import {
  buildSpawnEnv,
  ENV_ALLOWLIST,
  filterSpawnEnv,
  redactEnvForLog,
  roleCredentialEnv,
} from './env.js';

describe('spawn env allowlist §3.8 (issue #42)', () => {
  it('keeps allowlisted keys and drops everything else', () => {
    expect(ENV_ALLOWLIST).toContain('PATH');
    const out = filterSpawnEnv({
      PATH: '/bin',
      AWS_SECRET_ACCESS_KEY: 'parent-secret',
      KUBIC_UNRELATED_NOPE: 'x',
    });
    expect(out).toEqual({ PATH: '/bin' });
  });

  it('passes KUBIC_ namespaced non-secret keys through', () => {
    const out = filterSpawnEnv({ KUBIC_MODEL: 'faux', KUBIC_DEBUG: '1' });
    expect(out).toEqual({ KUBIC_MODEL: 'faux', KUBIC_DEBUG: '1' });
  });

  it('injects the role grant on top of the filtered base', () => {
    const out = buildSpawnEnv(
      { PATH: '/bin', PARENT_TOKEN: 'nope' },
      'reviewer',
      { KUBIC_ROLE_TOKEN: 'role-secret' },
    );
    expect(out).toEqual({
      PATH: '/bin',
      KUBIC_ROLE_TOKEN: 'role-secret',
    });
  });

  it('namespaces role creds per role so sibling grants never collide', () => {
    const a = roleCredentialEnv('writer', { token: 'aaa' });
    const b = roleCredentialEnv('reviewer', { token: 'bbb' });
    expect(a).toEqual({ KUBIC_ROLE_WRITER_TOKEN: 'aaa' });
    expect(b).toEqual({ KUBIC_ROLE_REVIEWER_TOKEN: 'bbb' });
    expect(a).not.toEqual(b);
  });

  it('redacts secret values for --debug lines, keeping the keys', () => {
    const redacted = redactEnvForLog({
      PATH: '/bin',
      KUBIC_ROLE_TOKEN: 'shh',
    });
    expect(redacted).toEqual({ PATH: '/bin', KUBIC_ROLE_TOKEN: '<redacted>' });
  });
});
