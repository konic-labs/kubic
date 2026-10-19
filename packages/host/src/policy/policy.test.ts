// Enterprise policy engine tests (surface, precedence). Faux-only, zero
// network.
import { describe, expect, it } from 'vitest';
import {
  assertToolGrantable,
  isToolAllowed,
  isToolAllowedByEnterprise,
} from './gates.js';
import { resolveEffectivePolicy } from './resolve.js';
import { POLICY_LAYERS, PolicyDeniedError, PolicyError } from './types.js';

describe('policy vocabulary bridge', () => {
  const POLICY_EXAMPLE = `[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"

data_policy = "no-external-training"
logging_policy = "full-audit"
`;

  it('translates the policy example into engine leaves', async () => {
    const mod = await import('./index.js');
    const { parseTomlConfig } = await import('../config/index.js');
    const layer = mod.layerPolicyFromConfig(parseTomlConfig(POLICY_EXAMPLE));
    expect(layer.tools?.allow).toContain('bash');
    expect(layer.tools?.deny).toEqual(['network_fetch']);
    expect(layer.models?.allowed).toEqual(['claude-sonnet-4-6', 'local/*']);
    expect(layer.models?.providers).toEqual(['anthropic', 'local']);
    // 'proxy' is the engine's allowlist mode; Kubic has no proxy
    // enforcement, so the shape is what travels here.
    expect(layer.network?.mode).toBe('allowlist');
    expect(layer.network?.domains).toEqual([
      'registry.npmjs.org',
      'github.com',
    ]);
    // 'workspace-only' is the engine's 'workspace-write' level.
    expect(layer.filesystem?.level).toBe('workspace-write');
    // Values with no enforceable engine leaf are carried, never dropped —
    // doctor reports them (the "never silent" rule).
    expect(layer.data?.policy).toBe('no-external-training');
    expect(layer.logging?.policy).toBe('full-audit');
  });

  it('returns an empty layer for a config with no [policy] section', async () => {
    const mod = await import('./index.js');
    expect(mod.layerPolicyFromConfig({})).toEqual({});
  });

  it('gates providers and models through provider-qualified patterns', async () => {
    const mod = await import('./index.js');
    const { policy } = mod.resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]);
    expect(mod.isProviderAllowed(policy, 'faux')).toBe(true);
    expect(mod.isProviderAllowed(policy, 'other')).toBe(false);
    expect(mod.isModelAllowed(policy, 'faux', 'anything')).toBe(true);
    expect(mod.isModelAllowed(policy, 'other', 'x')).toBe(false);
  });

  it('matches a bare model id across providers, keeping the provider gate', async () => {
    const mod = await import('./index.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          models: { providers: ['anthropic'], allowed: ['claude-sonnet-4-6'] },
        },
      },
    ]);
    expect(mod.isModelAllowed(policy, 'anthropic', 'claude-sonnet-4-6')).toBe(
      true,
    );
    expect(mod.isModelAllowed(policy, 'anthropic', 'claude-opus-4')).toBe(
      false,
    );
    // The providers list still bounds a bare-id pattern.
    expect(mod.isModelAllowed(policy, 'other', 'claude-sonnet-4-6')).toBe(
      false,
    );
  });

  it('refuses model patterns that are empty or cannot name a model', async () => {
    const mod = await import('./index.js');
    for (const pattern of ['', '  ', '/x', 'x/', 'a/b/c']) {
      expect(
        () =>
          mod.resolveEffectivePolicy([
            { layer: 'enterprise', policy: { models: { allowed: [pattern] } } },
          ]),
        pattern,
      ).toThrow(PolicyError);
    }
  });

  it('reports which layer set the allow list and which layer denied a tool', async () => {
    const mod = await import('./index.js');
    const resolved = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { tools: { allow: ['read'], deny: ['bash'] } },
      },
      { layer: 'project', policy: { tools: { allow: ['read', 'bash'] } } },
    ]);
    expect(resolved.policy.tools.allowSource).toBe('enterprise');
    expect(resolved.policy.tools.denySources).toEqual({ bash: 'enterprise' });
  });

  it('answers whether tool/model gates are configured at all', async () => {
    const mod = await import('./index.js');
    const empty = mod.resolveEffectivePolicy([]).policy;
    expect(mod.hasToolPolicy(empty)).toBe(false);
    expect(mod.hasModelPolicy(empty)).toBe(false);
    const tools = mod.resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]).policy;
    expect(mod.hasToolPolicy(tools)).toBe(true);
    expect(mod.hasModelPolicy(tools)).toBe(false);
    const models = mod.resolveEffectivePolicy([
      { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
    ]).policy;
    expect(mod.hasModelPolicy(models)).toBe(true);
  });
});

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
    // Every lower-layer attempt is named, not just "some" of them.
    expect(overriddenAttempts).toEqual(
      expect.arrayContaining([
        "project.tools.allow 'bash' rejected: enterprise denial holds",
        "session.tools.allow 'bash' rejected: enterprise denial holds",
        "agent.tools.allow 'git_push' rejected: enterprise denial holds",
      ]),
    );
  });

  it('every lower layer override of an enterprise denial is rejected (fuzz)', () => {
    for (const layer of POLICY_LAYERS) {
      if (layer === 'enterprise') continue;
      const { policy, overriddenAttempts } = resolveEffectivePolicy([
        { layer: 'enterprise', policy: ENTERPRISE_DENY.enterprise },
        denyInput(layer, 'bash'),
      ]);
      expect(isToolAllowed(policy, 'bash'), `layer ${layer}`).toBe(false);
      expect(overriddenAttempts, `layer ${layer}`).toContain(
        `${layer}.tools.allow 'bash' rejected: enterprise denial holds`,
      );
      // Control: the same lower-layer grant DOES enable a tool the
      // enterprise layer did not deny, so the denial above is load-bearing.
      const control = resolveEffectivePolicy([
        { layer: 'enterprise', policy: { tools: { deny: ['git_push'] } } },
        denyInput(layer, 'bash'),
      ]).policy;
      expect(isToolAllowed(control, 'bash'), `control ${layer}`).toBe(true);
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

  it('a grant follows the lane gate: a deny-only policy grants what it does not deny', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
    ]);
    // No allow list: the enterprise layer says nothing about `grep`, so the
    // grant path agrees with the lane's own gate instead of refusing it.
    expect(isToolAllowedByEnterprise(policy, 'grep')).toBe(true);
    expect(() =>
      assertToolGrantable(policy, 'grep', { layer: 'agent', role: 'reviewer' }),
    ).not.toThrow();
    expect(() =>
      assertToolGrantable(policy, 'bash', { layer: 'agent', role: 'reviewer' }),
    ).toThrow(/role 'reviewer'.*enterprise denial holds/);
    // With an allow list, an unlisted tool is still refused.
    const allowed = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { allow: ['read'] } } },
    ]).policy;
    expect(() =>
      assertToolGrantable(allowed, 'read', { layer: 'agent' }),
    ).not.toThrow();
    expect(() =>
      assertToolGrantable(allowed, 'grep', { layer: 'agent' }),
    ).toThrow(PolicyDeniedError);
  });

  it('deny-by-default: unlisted tools are denied', () => {
    const { policy } = resolveEffectivePolicy([
      { layer: 'enterprise', policy: { tools: { allow: ['read'] } } },
    ]);
    expect(isToolAllowed(policy, 'read')).toBe(true);
    expect(isToolAllowed(policy, 'write')).toBe(false);
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

describe('policy surface', () => {
  it('resolves models, filesystem, data, logging and audit sinks', async () => {
    const mod = await import('./index.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          models: { providers: ['local'], ids: ['llama3'], thinking: 'medium' },
          filesystem: { level: 'read', roots: ['/repo'] },
          data: { retentionDays: 30, redactSecrets: true },
          logging: { level: 'info', destinations: ['audit'] },
          audit: { sinks: [{ kind: 'syslog', target: 'local0' }] },
        },
      },
    ]);
    expect(mod.isProviderAllowed(policy, 'local')).toBe(true);
    expect(mod.isProviderAllowed(policy, 'openai')).toBe(false);
    expect(mod.isModelAllowed(policy, 'local', 'llama3')).toBe(true);
    expect(mod.isModelAllowed(policy, 'local', 'other')).toBe(false);
    expect(policy.filesystem.level).toBe('read');
    expect(policy.audit.sinks[0]?.kind).toBe('syslog');
  });

  it('lower layers cannot lift an enterprise filesystem denial', async () => {
    const mod = await import('./index.js');
    const { policy, overriddenAttempts } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { filesystem: { level: 'read' } },
      },
      {
        layer: 'project',
        policy: { filesystem: { level: 'full' } },
      },
    ]);
    expect(policy.filesystem.level).toBe('read');
    expect(overriddenAttempts.length).toBeGreaterThan(0);
  });
});

describe('enterprise doctor checks', () => {
  it('unenforceable syslog sink is reported, never silent', async () => {
    const mod = await import('./index.js');
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
    const mod = await import('./index.js');
    const { policy } = mod.resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: { audit: { sinks: [{ kind: 'syslog', target: 'local0' }] } },
      },
    ]);
    const checks = mod.enterpriseDoctorChecks(policy, {
      syslogAvailable: true,
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
  });

  // Nothing enforces network_policy, so a configured one — an allowlist
  // with domains included — fails, and enforceability with it.
  it('reports a configured network_policy as not enforced', async () => {
    const mod = await import('./index.js');
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
    const network = checks.find((c) => c.id === 'policy:enterprise-network');
    expect(network).toMatchObject({
      status: 'fail',
      reason: 'policy-mismatch',
    });
    expect(network?.detail).toContain(
      'network_policy is not enforced: mode allowlist with 1 allowed domain(s)',
    );
    expect(
      checks.find((c) => c.id === 'policy:enterprise-enforceability')?.status,
    ).toBe('fail');
    // The sink check is unchanged by it.
    expect(checks.find((c) => c.id === 'policy:enterprise-sinks')?.status).toBe(
      'pass',
    );
  });

  it('empty sinks and non-syslog-first sinks fail loudly', async () => {
    const mod = await import('./index.js');
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

describe('secret-shape case transforms', () => {
  it('redactSecretShapes replaces uppercase SK- material', async () => {
    const shapes = await import('@kubic/core/secret-shapes');
    expect(shapes.containsSecretShape('SK-FAUX-TEST-KEY-0001')).toBe(true);
    const redacted = shapes.redactSecretShapes(
      'saw SK-FAUX-TEST-KEY-0001 on the wire',
    );
    expect(redacted).not.toContain('SK-FAUX-TEST-KEY-0001');
    expect(redacted).toContain(shapes.REDACTED_SECRET);
  });
});
