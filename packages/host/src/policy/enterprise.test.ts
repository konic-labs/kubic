// Enterprise policy engine tests (issue #57; §58 surface, precedence).
// RED first: imports fail until enterprise.ts lands. Faux-only, zero network.
import { describe, expect, it } from 'vitest';
import {
  assertToolGrantable,
  isNetworkAllowed,
  isToolAllowed,
  POLICY_LAYERS,
  PolicyDeniedError,
  PolicyError,
  resolveEffectivePolicy,
} from './enterprise.js';

const ENTERPRISE_DENY = {
  enterprise: {
    tools: { deny: ['bash', 'git_push'] },
    network: { mode: 'none' as const, domains: [] },
  },
};

function denyInput(
  layer: (typeof POLICY_LAYERS)[number],
  tool: string,
): { layer: (typeof POLICY_LAYERS)[number]; policy: unknown } {
  return { layer, policy: { tools: { allow: [tool] } } };
}

describe('enterprise precedence', () => {
  it('lower layers cannot override an enterprise tool denial', () => {
    const { policy, overriddenAttempts } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: ENTERPRISE_DENY.enterprise },
      denyInput('project', 'bash'),
      denyInput('session', 'bash'),
      denyInput('agent', 'git_push'),
    ]);
    expect(isToolAllowed(policy, 'bash')).toBe(false);
    expect(isToolAllowed(policy, 'git_push')).toBe(false);
    expect(overriddenAttempts.length).toBeGreaterThan(0);
  });

  it('every lower layer override of an enterprise denial is rejected (fuzz)', () => {
    for (const layer of POLICY_LAYERS) {
      if (layer === 'enterprise') continue;
      const { policy } = resolveEffectivePolicy([
        { layer: 'enterprise', policy: ENTERPRISE_DENY.enterprise },
        denyInput(layer, 'bash'),
      ]);
      expect(isToolAllowed(policy, 'bash'), `layer ${layer}`).toBe(false);
    }
  });

  it('denied tool is not re-enableable by project, role, or model grant', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: ENTERPRISE_DENY.enterprise },
      denyInput('project', 'bash'),
    ]);
    expect(() =>
      assertToolGrantable(policy, 'bash', { layer: 'project' }),
    ).toThrow(PolicyDeniedError);
    expect(() =>
      assertToolGrantable(policy, 'bash', { layer: 'agent', role: 'admin' }),
    ).toThrow(PolicyDeniedError);
    expect(() =>
      assertToolGrantable(policy, 'bash', { layer: 'agent', model: 'evil' }),
    ).toThrow(PolicyDeniedError);
  });

  it('deny-by-default: unlisted tools and hosts are denied', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { allow: ['read'] } } },
    ]);
    expect(isToolAllowed(policy, 'read')).toBe(true);
    expect(isToolAllowed(policy, 'write')).toBe(false);
    expect(isNetworkAllowed(policy, 'example.com')).toBe(false);
  });

  it('tool matching is case- and whitespace-insensitive', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: ENTERPRISE_DENY.enterprise },
    ]);
    expect(isToolAllowed(policy, 'Bash')).toBe(false);
    expect(isToolAllowed(policy, 'BASH')).toBe(false);
    expect(isToolAllowed(policy, 'bash ')).toBe(false);
    expect(() =>
      assertToolGrantable(policy, 'BASH', { layer: 'project' }),
    ).toThrow(PolicyDeniedError);
  });

  it('allow lists normalize the same way', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { allow: ['Read'] } } },
    ]);
    expect(isToolAllowed(policy, 'read')).toBe(true);
    expect(isToolAllowed(policy, ' READ ')).toBe(true);
    expect(isToolAllowed(policy, 'write')).toBe(false);
  });
});

describe('list hygiene', () => {
  it('refuses empty string entries in tools.deny', () => {
    expect(() =>
      resolveEffectivePolicy([
        { layer: 'enterprise', policy: { tools: { deny: [''] } } },
      ]),
    ).toThrow(PolicyError);
  });

  it('refuses whitespace-only entries', () => {
    expect(() =>
      resolveEffectivePolicy([
        { layer: 'enterprise', policy: { network: { domains: ['   '] } } },
      ]),
    ).toThrow(PolicyError);
  });

  it('dedupes repeated entries, order-preserved', () => {
    const { policy } = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { deny: ['bash', 'bash', 'git_push'] } },
      },
    ]);
    expect(policy.tools.deny).toEqual(['bash', 'git_push']);
  });
});

describe('section-58 surface', () => {
  it('resolves models, filesystem, credentials, data, logging, agent, and audit sinks', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          models: { providers: ['local'], ids: ['llama3'], thinking: 'medium' },
          filesystem: { level: 'read', roots: ['/repo'] },
          credentials: {
            requireCredentialBroker: true,
            denyLocalCredentials: true,
          },
          data: { retentionDays: 30, redactSecrets: true },
          logging: { level: 'info', destinations: ['audit'] },
          agent: { maxWorkers: 2, maxCostUsd: 5 },
          audit: { sinks: [{ kind: 'syslog', target: 'local0' }] },
        },
      },
    ]);
    expect(mod.isProviderAllowed(policy, 'local')).toBe(true);
    expect(mod.isProviderAllowed(policy, 'openai')).toBe(false);
    expect(mod.isModelAllowed(policy, 'local', 'llama3')).toBe(true);
    expect(mod.isModelAllowed(policy, 'local', 'other')).toBe(false);
    expect(policy.filesystem.level).toBe('read');
    expect(policy.credentials.requireCredentialBroker).toBe(true);
    expect(policy.agent.maxWorkers).toBe(2);
    expect(policy.audit.sinks[0]?.kind).toBe('syslog');
  });

  it('lower layers cannot lift enterprise filesystem or credential denials', async () => {
    const mod = await import('./enterprise.js');
    const { policy, overriddenAttempts } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          filesystem: { level: 'read' },
          credentials: { requireCredentialBroker: true },
        },
      },
      {
        layer: 'project',
        policy: {
          filesystem: { level: 'full' },
          credentials: { requireCredentialBroker: false },
        },
      },
    ]);
    expect(policy.filesystem.level).toBe('read');
    expect(policy.credentials.requireCredentialBroker).toBe(true);
    expect(overriddenAttempts.length).toBeGreaterThan(0);
  });
});

describe('credential broker', () => {
  it('broker=true leaves no secret material in worker env or dump', async () => {
    const mod = await import('./enterprise.js');
    const fauxA = 'sk-faux-test-key-0001';
    const fauxB = 'AKIAFAUXTEST00000001';
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { requireCredentialBroker: true } },
      },
    ]);
    const built = mod.buildBrokeredWorkerEnv(
      { API_KEY: fauxA, TOKEN: `prefix-${fauxB}-suffix` },
      [
        { ref: '$API_KEY', value: fauxA },
        { ref: '$TOKEN', value: fauxB },
      ],
      policy,
    );
    const dump = JSON.stringify(built.env);
    expect(dump).not.toContain(fauxA);
    expect(dump).not.toContain(fauxB);
    expect(() =>
      mod.assertNoSecretMaterial(built.env, [fauxA, fauxB]),
    ).not.toThrow();
    expect(built.env.API_KEY).toContain('broker:');
  });

  it('denyLocalCredentials refuses local credential keys in worker env', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { denyLocalCredentials: true } },
      },
    ]);
    expect(() =>
      mod.assertNoLocalCredentials({ GITHUB_TOKEN: 'ghp_faux0001' }, policy),
    ).toThrow(mod.PolicyDeniedError);
  });

  it('broker=true refuses unlisted secret-shaped values (no fail-open passthrough)', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { requireCredentialBroker: true } },
      },
    ]);
    expect(() =>
      mod.buildBrokeredWorkerEnv({ EVIL: 'sk-faux-test-key-0001' }, [], policy),
    ).toThrow(mod.PolicyDeniedError);
  });

  it('sentinels keep every replaced secret per key', async () => {
    const mod = await import('./enterprise.js');
    const fauxA = '«redacted:sk-…»';
    const fauxB = '«redacted:AKIA…»';
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { requireCredentialBroker: true } },
      },
    ]);
    const built = mod.buildBrokeredWorkerEnv(
      { COMBO: `${fauxA}+${fauxB}` },
      [
        { ref: '$A', value: fauxA },
        { ref: '$B', value: fauxB },
      ],
      policy,
    );
    expect(built.env.COMBO).toBe('broker:$A+broker:$B');
    expect(built.sentinels.COMBO).toEqual(['broker:$A', 'broker:$B']);
  });

  it('denyLocalCredentials refuses secret-shaped values under innocuous keys', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { denyLocalCredentials: true } },
      },
    ]);
    expect(() =>
      mod.assertNoLocalCredentials({ CONFIG: 'sk-faux-test-key-0001' }, policy),
    ).toThrow(mod.PolicyDeniedError);
    expect(() =>
      mod.assertNoLocalCredentials(
        { API_KEY: 'sk-faux-test-key-0001' },
        policy,
      ),
    ).toThrow(mod.PolicyDeniedError);
    expect(() =>
      mod.assertNoLocalCredentials({ CONFIG: 'plain-value' }, policy),
    ).not.toThrow();
  });
});

describe('enterprise doctor checks', () => {
  it('unenforceable syslog sink is reported, never silent', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { audit: { sinks: [{ kind: 'syslog', target: 'local0' }] } },
      },
    ]);
    const checks = mod.enterpriseDoctorChecks(policy, {
      syslogAvailable: false,
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.status === 'fail')).toBe(true);
  });

  it('clean policy still emits checks (never silent) and syslog-first holds', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          network: { mode: 'allowlist', domains: ['example.com'] },
          audit: { sinks: [{ kind: 'syslog', target: 'local0' }] },
        },
      },
    ]);
    const checks = mod.enterpriseDoctorChecks(policy, {
      syslogAvailable: true,
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('empty sinks and non-syslog-first sinks fail loudly', async () => {
    const mod = await import('./enterprise.js');
    const empty = mod.resolveEffectivePolicy([
      { layer: 'enterprise', policy: {} },
    ]).policy;
    expect(
      mod
        .enterpriseDoctorChecks(empty, { syslogAvailable: true })
        .some((c) => c.status === 'fail'),
    ).toBe(true);
    const fileFirst = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { audit: { sinks: [{ kind: 'file', target: '/tmp/a.log' }] } },
      },
    ]).policy;
    expect(
      mod
        .enterpriseDoctorChecks(fileFirst, { syslogAvailable: true })
        .some((c) => c.status === 'fail'),
    ).toBe(true);
  });
});

describe('case-transform bypass (fix cycle 2)', () => {
  it('broker backstop refuses uppercase SK- values with no inventory', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { requireCredentialBroker: true } },
      },
    ]);
    expect(() =>
      mod.buildBrokeredWorkerEnv({ EVIL: 'SK-FAUX-TEST-KEY-0001' }, [], policy),
    ).toThrow(mod.PolicyDeniedError);
  });

  it('denyLocalCredentials refuses uppercase SK- values under innocuous keys', async () => {
    const mod = await import('./enterprise.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { credentials: { denyLocalCredentials: true } },
      },
    ]);
    expect(() =>
      mod.assertNoLocalCredentials({ CONFIG: 'SK-FAUX-TEST-KEY-0001' }, policy),
    ).toThrow(mod.PolicyDeniedError);
  });

  it('redactSecretShapes replaces uppercase SK- material', async () => {
    const shapes = await import('./secret-shapes.js');
    expect(shapes.containsSecretShape('SK-FAUX-TEST-KEY-0001')).toBe(true);
    const redacted = shapes.redactSecretShapes(
      'saw SK-FAUX-TEST-KEY-0001 on the wire',
    );
    expect(redacted).not.toContain('SK-FAUX-TEST-KEY-0001');
    expect(redacted).toContain(shapes.REDACTED_SECRET);
  });

  it.each(['BEARER', 'bEaReR', 'BeArEr'])(
    'broker backstop refuses %s-scheme values with no inventory',
    async (scheme) => {
      const mod = await import('./enterprise.js');
      const { policy } = mod.resolveEffectivePolicy([
        {
          layer: 'enterprise',
          policy: { credentials: { requireCredentialBroker: true } },
        },
      ]);
      expect(() =>
        mod.buildBrokeredWorkerEnv(
          { EVIL: `${scheme} faux-token-0001-abcdef` },
          [],
          policy,
        ),
      ).toThrow(mod.PolicyDeniedError);
    },
  );

  it.each(['BEARER', 'bEaReR', 'BeArEr'])(
    'denyLocalCredentials refuses %s-scheme values under innocuous keys',
    async (scheme) => {
      const mod = await import('./enterprise.js');
      const { policy } = mod.resolveEffectivePolicy([
        {
          layer: 'enterprise',
          policy: { credentials: { denyLocalCredentials: true } },
        },
      ]);
      expect(() =>
        mod.assertNoLocalCredentials(
          { CONFIG: `${scheme} faux-token-0001-abcdef` },
          policy,
        ),
      ).toThrow(mod.PolicyDeniedError);
    },
  );
});
