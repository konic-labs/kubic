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
    const out = filterSpawnEnv({
      KUBIC_MODEL: 'faux',
      KUBIC_PROVIDER: 'faux',
      KUBIC_DEBUG: '1',
    });
    expect(out).toEqual({
      KUBIC_MODEL: 'faux',
      KUBIC_PROVIDER: 'faux',
      KUBIC_DEBUG: '1',
    });
  });

  it("passes the manager's models root and trust decision through (issue #222)", () => {
    const out = filterSpawnEnv({
      KUBIC_MODELS_ROOT: '/repo',
      KUBIC_TRUST_PROJECT: '1',
    });
    expect(out).toEqual({
      KUBIC_MODELS_ROOT: '/repo',
      KUBIC_TRUST_PROJECT: '1',
    });
  });

  it('injects the role grant on top of the filtered base', () => {
    const out = buildSpawnEnv(
      { PATH: '/bin', PARENT_TOKEN: 'nope' },
      'reviewer',
      { token: 'role-secret' },
    );
    expect(out).toEqual({
      PATH: '/bin',
      KUBIC_ROLE_REVIEWER_TOKEN: 'role-secret',
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

  it('redacts every grant-derived key by provenance, not suffix', () => {
    const spawned = buildSpawnEnv({ PATH: '/bin' }, 'reviewer', {
      session: 's3cr3t-value',
    });
    expect(spawned.KUBIC_ROLE_REVIEWER_SESSION).toBe('s3cr3t-value');
    const redacted = redactEnvForLog(spawned);
    expect(redacted.KUBIC_ROLE_REVIEWER_SESSION).toBe('<redacted>');
    expect(redacted.PATH).toBe('/bin');
  });

  it('refuses KUBIC_-prefixed grant keys instead of minting child env', () => {
    expect(() =>
      buildSpawnEnv({ PATH: '/bin' }, 'reviewer', {
        KUBIC_INJECTED: 'evil',
      }),
    ).toThrow(/KUBIC_INJECTED/);
  });

  it('refuses sibling-impersonating grant keys instead of passing them through', () => {
    expect(() =>
      roleCredentialEnv('reviewer', { KUBIC_ROLE_OTHER_TOKEN: 'x' }),
    ).toThrow(/KUBIC_ROLE_OTHER_TOKEN/);
  });
});
