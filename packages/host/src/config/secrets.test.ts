// Request-time secrets, audit, ScopedToken, per-role env (issue #38) — RED first.
import { describe, expect, it } from 'vitest';
import {
  AGENT_ENV_ALLOWLIST,
  assertNoPlaintextSecrets,
  buildAgentEnv,
  containsPlaintextSecret,
  issueScopedToken,
  parseSecretRef,
  redactSecretValues,
  resolveRoleCredentials,
  resolveSecretRef,
  revokeAllTokens,
  type SecretAuditEvent,
  type SecretResolverDeps,
  substituteTokenHost,
  useScopedToken,
} from './secrets.js';

// NEVER real secrets in tests — [REDACTED]-style fixtures only.
const FIXTURE_KEY_A = '[REDACTED-test-key-a]';
const FIXTURE_KEY_B = '[REDACTED-test-key-b]';

function deps(overrides: Partial<SecretResolverDeps> = {}): {
  deps: SecretResolverDeps;
  audit: SecretAuditEvent[];
  commands: string[][];
} {
  const audit: SecretAuditEvent[] = [];
  const commands: string[][] = [];
  return {
    deps: {
      env: { KUBIC_TEST_KEY: FIXTURE_KEY_A },
      runCommand: (argv: string[]) => {
        commands.push(argv);
        return FIXTURE_KEY_B;
      },
      audit: (event: SecretAuditEvent): void => {
        audit.push(event);
      },
      now: () => 1_700_000_000_000,
      ...overrides,
    },
    audit,
    commands,
  };
}

describe('models.json secret refs (issue #38)', () => {
  it('resolves $ENV_VAR from the injected env', async () => {
    const { deps: d, audit } = deps();
    const value = await resolveSecretRef(parseSecretRef('$KUBIC_TEST_KEY'), d, {
      role: 'reviewer',
      purpose: 'provider-auth',
    });
    expect(value).toBe(FIXTURE_KEY_A);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      role: 'reviewer',
      ref: '$KUBIC_TEST_KEY',
    });
  });

  it('fails closed on missing env vars', async () => {
    const { deps: d } = deps();
    await expect(
      resolveSecretRef(parseSecretRef('$KUBIC_MISSING_KEY'), d, {
        role: 'reviewer',
        purpose: 'provider-auth',
      }),
    ).rejects.toThrow(/KUBIC_MISSING_KEY/);
  });

  it('re-runs !command on every resolve (no TTL)', async () => {
    const { deps: d, commands } = deps();
    const ref = parseSecretRef('!pass show api-key');
    const ctx = { role: 'implementer', purpose: 'provider-auth' };
    await resolveSecretRef(ref, d, ctx);
    await resolveSecretRef(ref, d, ctx);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(['pass', 'show', 'api-key']);
  });

  it('keeps escaped literals literal', async () => {
    const { deps: d, audit, commands } = deps();
    const ctx = { role: 'reviewer', purpose: 'probe' };
    expect(
      await resolveSecretRef(parseSecretRef('\\$KUBIC_TEST_KEY'), d, ctx),
    ).toBe('$KUBIC_TEST_KEY');
    expect(await resolveSecretRef(parseSecretRef('\\!literal'), d, ctx)).toBe(
      '!literal',
    );
    expect(commands).toHaveLength(0);
    expect(audit).toHaveLength(2);
  });

  it('rejects non-string refs', () => {
    expect(() => parseSecretRef(null)).toThrow(/string/);
    expect(() => parseSecretRef({ key: 1 })).toThrow(/string/);
  });
});

describe('redaction + audit (issue #38)', () => {
  it('redacts secret values out of config/trajectory/log payloads', () => {
    const payload = {
      provider: 'local',
      auth: FIXTURE_KEY_A,
      nested: { note: `key=${FIXTURE_KEY_B} ok` },
      list: [FIXTURE_KEY_A, 'public'],
    };
    const redacted = redactSecretValues(payload, [
      FIXTURE_KEY_A,
      FIXTURE_KEY_B,
    ]);
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_KEY_A);
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_KEY_B);
    expect(JSON.stringify(redacted)).toContain('[REDACTED]');
  });

  it('detects plaintext secrets in log lines', () => {
    expect(
      containsPlaintextSecret(`using ${FIXTURE_KEY_A}`, [FIXTURE_KEY_A]),
    ).toBe(true);
    expect(containsPlaintextSecret('using [REDACTED]', [FIXTURE_KEY_A])).toBe(
      false,
    );
    expect(() =>
      assertNoPlaintextSecrets([`leak ${FIXTURE_KEY_A}`], [FIXTURE_KEY_A]),
    ).toThrow(/plaintext/i);
    expect(() =>
      assertNoPlaintextSecrets(['clean [REDACTED] line'], [FIXTURE_KEY_A]),
    ).not.toThrow();
  });

  it('audits every secret use', async () => {
    const { deps: d, audit } = deps();
    const ref = parseSecretRef('$KUBIC_TEST_KEY');
    await resolveSecretRef(ref, d, { role: 'r1', purpose: 'p1' });
    await resolveSecretRef(ref, d, { role: 'r1', purpose: 'p2' });
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ role: 'r1', purpose: 'p2' });
  });
});

describe('ScopedToken (issue #38)', () => {
  it('authorizes use on a bound host within budget', () => {
    const token = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 60_000,
      hosts: ['registry.example.com'],
      maxUses: 2,
      now: 1_000,
    });
    expect(token.expiresAt).toBe(61_000);
    expect(token.revoked).toBe(false);
    expect(useScopedToken(token, 'registry.example.com', 2_000)).toBe(
      FIXTURE_KEY_A,
    );
    expect(token.remainingUses).toBe(1);
  });

  it('refuses hosts outside the binding (host-substitution is host-restricted)', () => {
    const token = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 60_000,
      hosts: ['registry.example.com'],
      maxUses: 2,
      now: 1_000,
    });
    expect(() => useScopedToken(token, 'evil.example.com', 2_000)).toThrow(
      /host/i,
    );
    expect(() =>
      substituteTokenHost(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CRED} is the placeholder syntax under test
        'https://${CRED}@x/',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CRED} is the placeholder syntax under test
        '${CRED}',
        token,
        'evil.example.com',
        2_000,
      ),
    ).toThrow(/host/i);
  });

  it('substitutes tokens only on bound hosts', () => {
    const token = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 60_000,
      hosts: ['registry.example.com'],
      maxUses: 2,
      now: 1_000,
    });
    const out = substituteTokenHost(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CRED} is the placeholder syntax under test
      'https://${CRED}@registry.example.com/v1',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CRED} is the placeholder syntax under test
      '${CRED}',
      token,
      'registry.example.com',
      2_000,
    );
    expect(out).toContain(FIXTURE_KEY_A);
  });

  it('expires tokens and exhausts budgets', () => {
    const token = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 1_000,
      hosts: ['h'],
      maxUses: 1,
      now: 1_000,
    });
    expect(() => useScopedToken(token, 'h', 3_000)).toThrow(/expir/i);
    const fresh = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 60_000,
      hosts: ['h'],
      maxUses: 1,
      now: 1_000,
    });
    expect(useScopedToken(fresh, 'h', 2_000)).toBe(FIXTURE_KEY_A);
    expect(() => useScopedToken(fresh, 'h', 2_000)).toThrow(/budget|uses/i);
  });

  it('revokes tokens at settle/exit', () => {
    const a = issueScopedToken(FIXTURE_KEY_A, {
      ttlMs: 60_000,
      hosts: ['h'],
      maxUses: 5,
      now: 1_000,
    });
    const b = issueScopedToken(FIXTURE_KEY_B, {
      ttlMs: 60_000,
      hosts: ['h'],
      maxUses: 5,
      now: 1_000,
    });
    revokeAllTokens([a, b]);
    expect(a.revoked).toBe(true);
    expect(b.revoked).toBe(true);
    expect(() => useScopedToken(a, 'h', 2_000)).toThrow(/revok/i);
  });
});

describe('per-role injection (issue #38)', () => {
  it('gives a worker only its own role creds', () => {
    const reviewer = resolveRoleCredentials(
      'reviewer',
      { readKey: FIXTURE_KEY_A },
      { version: 1, ttlMs: 60_000, hosts: ['h'], maxUses: 3, now: 1_000 },
    );
    const implementer = resolveRoleCredentials(
      'implementer',
      { writeKey: FIXTURE_KEY_B },
      { version: 1, ttlMs: 60_000, hosts: ['h'], maxUses: 3, now: 1_000 },
    );
    expect(Object.keys(reviewer.tokens)).toEqual(['readKey']);
    expect(Object.keys(implementer.tokens)).toEqual(['writeKey']);
  });

  it('re-resolves on change instead of inheriting', () => {
    const first = resolveRoleCredentials(
      'reviewer',
      { readKey: FIXTURE_KEY_A },
      { version: 1, ttlMs: 60_000, hosts: ['h'], maxUses: 3, now: 1_000 },
    );
    const second = resolveRoleCredentials(
      'reviewer',
      { readKey: FIXTURE_KEY_B },
      { version: 2, ttlMs: 60_000, hosts: ['h'], maxUses: 3, now: 1_000 },
    );
    expect(second.version).toBe(2);
    expect(useScopedToken(second.tokens.readKey, 'h', 2_000)).toBe(
      FIXTURE_KEY_B,
    );
    expect(first.tokens.readKey).not.toBe(second.tokens.readKey);
  });
});

describe('agent env allowlist (issue #38)', () => {
  it('exposes allowlist ∪ role creds with no ambient leak', () => {
    expect(AGENT_ENV_ALLOWLIST).toContain('PATH');
    const env = buildAgentEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        KUBIC_AMBIENT_LEAK_PROBE: 'leak',
        AWS_SECRET_ACCESS_KEY: '[REDACTED-fixture]',
      },
      AGENT_ENV_ALLOWLIST,
      { KUBIC_ROLE_KEY: FIXTURE_KEY_A },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.KUBIC_ROLE_KEY).toBe(FIXTURE_KEY_A);
    expect('KUBIC_AMBIENT_LEAK_PROBE' in env).toBe(false);
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
  });
});
