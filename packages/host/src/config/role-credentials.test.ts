// §36.3 provider-credential scoping for orchestrator workers (issue #200).
// These are the pure decisions: which provider a worker's role resolves to,
// exactly which key env vars that provider needs, what a worker is granted,
// and when the run must refuse before any worktree exists. The launch path
// (apps/kubic orchestrate-run) and `kubic doctor` consume this module, so the
// two surfaces cannot disagree.
import { describe, expect, it } from 'vitest';
import { assertNoSecretMaterial } from '../policy/enterprise.js';
import {
  firstDeliverableProvider,
  type ProviderKeyIndex,
  planWorkerCredentials,
  providerOfModelRef,
  resolveProviderGrant,
  resolveWorkerProvider,
  workerCredentialDoctorProbe,
} from './role-credentials.js';

const SECRET = 'sk-worker-200-key';

const INDEX: ProviderKeyIndex = new Map([
  ['gw', { envVars: ['GW_API_KEY'], noKeyNeeded: false }],
  ['anthropic', { envVars: ['ANTHROPIC_API_KEY'], noKeyNeeded: false }],
  ['local', { envVars: [], noKeyNeeded: true }],
  // A provider the manager authenticated without any env key (an ambient
  // credential file): nothing to forward, the child resolves the same file.
  ['bedrock', { envVars: [], noKeyNeeded: true }],
  // Registered, but the manager holds no usable credential for it.
  ['unusable', { envVars: [], noKeyNeeded: false }],
]);

const ENV = { GW_API_KEY: SECRET, ANTHROPIC_API_KEY: 'sk-anthropic-200' };

describe('provider resolution for a worker role (issue #200)', () => {
  it('reads the provider out of a provider/model ref', () => {
    expect(providerOfModelRef('gw/m1')).toBe('gw');
    expect(providerOfModelRef('openai/gpt-5')).toBe('openai');
    expect(providerOfModelRef('m1')).toBeUndefined();
    expect(providerOfModelRef('/m1')).toBeUndefined();
    expect(providerOfModelRef('gw/')).toBeUndefined();
    expect(providerOfModelRef(undefined)).toBeUndefined();
  });

  it('mirrors the launch contract precedence: the told pin, env pin, manager pin, fallback', () => {
    // Issue #202: the child is TOLD `modelRef` as its `KUBIC_MODEL`, so an
    // ambient operator pin the manager overwrote must not decide the grant —
    // the role's provider would then run without its key.
    expect(
      resolveWorkerProvider({
        envModel: 'anthropic/claude',
        modelRef: 'gw/m1',
        managerModel: 'openai/gpt-5',
        fallbackProvider: 'local',
      }),
    ).toBe('gw');
    // No told pin: the child inherits the ambient `KUBIC_MODEL`, so that one
    // decides.
    expect(
      resolveWorkerProvider({
        envModel: 'anthropic/claude',
        managerModel: 'openai/gpt-5',
        fallbackProvider: 'local',
      }),
    ).toBe('anthropic');
    expect(
      resolveWorkerProvider({
        modelRef: 'gw/m1',
        managerModel: 'openai/gpt-5',
        fallbackProvider: 'local',
      }),
    ).toBe('gw');
    expect(
      resolveWorkerProvider({
        managerModel: 'openai/gpt-5',
        fallbackProvider: 'local',
      }),
    ).toBe('openai');
    expect(resolveWorkerProvider({ fallbackProvider: 'local' })).toBe('local');
    expect(resolveWorkerProvider({})).toBeUndefined();
  });

  it('a frozen enterprise pin decides alone: the env pin and the role pin are dropped by the child (issue #295)', () => {
    expect(
      resolveWorkerProvider({
        modelFrozen: true,
        envModel: 'anthropic/claude',
        modelRef: 'gw/m1',
        managerModel: 'openai/gpt-5',
        fallbackProvider: 'local',
      }),
    ).toBe('openai');
    // No usable manager pin: the fallback, never the dropped pins.
    expect(
      resolveWorkerProvider({
        modelFrozen: true,
        envModel: 'anthropic/claude',
        modelRef: 'gw/m1',
        fallbackProvider: 'local',
      }),
    ).toBe('local');
    expect(
      resolveWorkerProvider({
        modelFrozen: true,
        envModel: 'anthropic/claude',
        modelRef: 'gw/m1',
      }),
    ).toBeUndefined();
    // Not frozen (explicitly false): the ordinary precedence stands.
    expect(
      resolveWorkerProvider({
        modelFrozen: false,
        envModel: 'anthropic/claude',
        managerModel: 'openai/gpt-5',
      }),
    ).toBe('anthropic');
  });
});

describe('resolveProviderGrant (issue #200)', () => {
  it('grants exactly the key env vars the provider needs', () => {
    const result = resolveProviderGrant('gw', { keyEnv: INDEX, env: ENV });
    expect(result).toEqual({ kind: 'grant', grant: { GW_API_KEY: SECRET } });
  });

  it('never grants a key the provider does not use', () => {
    const result = resolveProviderGrant('gw', { keyEnv: INDEX, env: ENV });
    expect(result.kind).toBe('grant');
    if (result.kind !== 'grant') return;
    expect(Object.keys(result.grant)).toEqual(['GW_API_KEY']);
    expect(JSON.stringify(result.grant)).not.toContain('sk-anthropic-200');
  });

  it('refuses by name when the key is not in the orchestrator env', () => {
    const result = resolveProviderGrant('gw', {
      keyEnv: INDEX,
      env: { ANTHROPIC_API_KEY: 'sk-anthropic-200' },
    });
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.provider).toBe('gw');
    expect(result.message).toContain("provider 'gw'");
    expect(result.message).toContain('GW_API_KEY');
  });

  it('refuses by name when the provider has no usable credential at all', () => {
    const result = resolveProviderGrant('unusable', {
      keyEnv: INDEX,
      env: ENV,
    });
    expect(result).toMatchObject({ kind: 'refusal', provider: 'unusable' });
    if (result.kind !== 'refusal') return;
    expect(result.message).toContain("provider 'unusable'");
  });

  it('refuses by name, stating why, when the credential cannot reach a worker at all', () => {
    // A provider authenticated from process-level configuration the worker
    // env cannot carry: its `envVars` are empty and `noKeyNeeded` is false
    // is not enough to say WHY — the reason travels with the entry.
    const index: ProviderKeyIndex = new Map([
      [
        'cloudy',
        {
          envVars: [],
          noKeyNeeded: false,
          undeliverable: 'reads CLOUDY_* from the process environment',
        },
      ],
    ]);
    expect(resolveProviderGrant('cloudy', { keyEnv: index, env: ENV })).toEqual(
      {
        kind: 'refusal',
        provider: 'cloudy',
        message:
          "no credential for provider 'cloudy': reads CLOUDY_* from the process environment",
      },
    );
  });

  it('an undeliverable credential wins over a keyless flag and over a set key', () => {
    const index: ProviderKeyIndex = new Map([
      [
        'both',
        {
          envVars: ['GW_API_KEY'],
          noKeyNeeded: true,
          undeliverable: 'process-level configuration',
        },
      ],
    ]);
    const result = resolveProviderGrant('both', { keyEnv: index, env: ENV });
    expect(result).toMatchObject({ kind: 'refusal', provider: 'both' });
  });

  it('forwards every companion env var alongside the key, and refuses naming the missing one', () => {
    const index: ProviderKeyIndex = new Map([
      [
        'cf',
        {
          envVars: ['CF_API_KEY', 'CF_ACCOUNT_ID'],
          noKeyNeeded: false,
        },
      ],
    ]);
    expect(
      resolveProviderGrant('cf', {
        keyEnv: index,
        env: { CF_API_KEY: 'k', CF_ACCOUNT_ID: 'acc' },
      }),
    ).toEqual({
      kind: 'grant',
      grant: { CF_API_KEY: 'k', CF_ACCOUNT_ID: 'acc' },
    });
    const refused = resolveProviderGrant('cf', {
      keyEnv: index,
      env: { CF_API_KEY: 'k' },
    });
    expect(refused).toMatchObject({ kind: 'refusal', provider: 'cf' });
    if (refused.kind !== 'refusal') return;
    expect(refused.message).toContain('$CF_ACCOUNT_ID');
    expect(refused.message).not.toContain('$CF_API_KEY');
  });

  it('a keyless provider needs nothing and is not a refusal', () => {
    expect(resolveProviderGrant('local', { keyEnv: INDEX, env: {} })).toEqual({
      kind: 'grant',
      grant: {},
    });
  });

  it('an unregistered provider is not a credential refusal — the child names it', () => {
    expect(
      resolveProviderGrant('not-registered', { keyEnv: INDEX, env: ENV }),
    ).toEqual({ kind: 'grant', grant: {} });
  });

  it('an unpinned worker (no provider) carries no grant, never a refusal', () => {
    expect(
      resolveProviderGrant(undefined, { keyEnv: INDEX, env: ENV }),
    ).toEqual({ kind: 'grant', grant: {} });
  });

  it('with require_credential_broker the grant holds sentinels, never material', () => {
    const result = resolveProviderGrant('gw', {
      keyEnv: INDEX,
      env: ENV,
      requireCredentialBroker: true,
    });
    expect(result.kind).toBe('grant');
    if (result.kind !== 'grant') return;
    expect(result.grant.GW_API_KEY).toBe('broker:$GW_API_KEY');
    expect(() =>
      assertNoSecretMaterial(result.grant, [SECRET, 'sk-anthropic-200']),
    ).not.toThrow();
  });
});

describe('planWorkerCredentials (issue #200)', () => {
  const deps = {
    keyEnv: INDEX,
    env: ENV,
    resolution: { fallbackProvider: 'local' },
  };

  it('grants each agent only its own role provider key', () => {
    const plan = planWorkerCredentials(
      [
        { agentId: 'alpha', role: 'planner', modelRef: 'gw/m1' },
        { agentId: 'beta', role: 'implementer', modelRef: 'anthropic/claude' },
      ],
      deps,
    );
    expect(plan.refusal).toBeUndefined();
    expect(plan.grants.get('alpha')).toEqual({
      agentId: 'alpha',
      role: 'planner',
      provider: 'gw',
      grant: { GW_API_KEY: SECRET },
    });
    expect(plan.grants.get('beta')?.grant).toEqual({
      ANTHROPIC_API_KEY: 'sk-anthropic-200',
    });
  });

  it('reports the FIRST undeliverable credential by provider name, still planning the rest', () => {
    const plan = planWorkerCredentials(
      [
        { agentId: 'alpha', role: 'planner', modelRef: 'unusable/m' },
        { agentId: 'beta', role: 'implementer', modelRef: 'gw/m1' },
      ],
      deps,
    );
    expect(plan.refusal).toMatchObject({
      agentId: 'alpha',
      role: 'planner',
      provider: 'unusable',
    });
    // The deliverable role is still planned — the refusal is what fails the
    // run, not a hole in the plan.
    expect(plan.grants.get('beta')?.grant).toEqual({ GW_API_KEY: SECRET });
  });
});

describe('workerCredentialDoctorProbe (issue #200)', () => {
  const deps = {
    keyEnv: INDEX,
    env: ENV,
    resolution: { fallbackProvider: 'local' },
  };

  it('lists one provider per role, names only', () => {
    const probe = workerCredentialDoctorProbe(
      [
        { agentId: 'alpha', role: 'planner', modelRef: 'gw/m1' },
        { agentId: 'beta', role: 'implementer', modelRef: 'anthropic/claude' },
      ],
      deps,
    );
    expect(probe).toEqual({
      ok: true,
      detail: 'planner→gw, implementer→anthropic',
    });
    expect(probe.detail).not.toContain(SECRET);
  });

  it('fails with the named provider when a credential cannot be delivered', () => {
    const probe = workerCredentialDoctorProbe(
      [{ agentId: 'alpha', role: 'planner', modelRef: 'unusable/m' }],
      deps,
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("provider 'unusable'");
  });

  it('names the fallback provider when no role is assigned', () => {
    const probe = workerCredentialDoctorProbe([], deps);
    expect(probe).toEqual({
      ok: true,
      detail: 'no roles assigned; workers resolve local',
    });
  });
});

describe('firstDeliverableProvider (issue #200)', () => {
  it('skips an undeliverable candidate instead of refusing on a guessed pick', () => {
    expect(
      firstDeliverableProvider(['unusable', 'gw', 'local'], {
        keyEnv: INDEX,
        env: ENV,
      }),
    ).toBe('gw');
  });

  it('returns undefined when nothing on the list can be delivered', () => {
    expect(
      firstDeliverableProvider(['unusable'], { keyEnv: INDEX, env: {} }),
    ).toBeUndefined();
    expect(
      firstDeliverableProvider([], { keyEnv: INDEX, env: ENV }),
    ).toBeUndefined();
  });

  it('treats an unregistered candidate as nothing to deliver, not a refusal', () => {
    expect(
      firstDeliverableProvider(['not-registered'], { keyEnv: INDEX, env: {} }),
    ).toBe('not-registered');
  });
});
