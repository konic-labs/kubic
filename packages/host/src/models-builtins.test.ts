// Pi's built-in providers in the assembled catalog (issue #221; §37.1,
// §37.2). Hermetic: every assembly gets a stubbed env and a temp home, so
// the machine's own keys never decide an outcome, and nothing is dialled
// (auth checks read the stubbed env only; streams are never opened).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSpawnEnv,
  withRoleGrant,
} from '../../worker/src/lifecycle/env.js';
import {
  ModelSelectError,
  selectModel,
} from '../../worker/src/model-select.js';
import { resolveProviderGrant } from './config/role-credentials.js';
import {
  assembleModels,
  providerProbesOf,
  runModelsCommand,
} from './models-cli.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mb-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function assemble(
  env: Record<string, string | undefined>,
  cwd: string = tmpDir(),
) {
  return assembleModels(cwd, env, { home: tmpDir() });
}

describe('built-in providers (issue #221)', () => {
  it('registers the Pi built-ins with no models.json', async () => {
    const assembled = await assemble({});
    for (const id of ['anthropic', 'openai', 'google', 'amazon-bedrock']) {
      expect(assembled.models.getProvider(id)?.id).toBe(id);
    }
    expect(
      assembled.models.getModel('anthropic', 'claude-sonnet-4-6')?.id,
    ).toBe('claude-sonnet-4-6');
    expect(assembled.providers.get('anthropic')?.origin).toBe('built-in');
  });

  it('marks a built-in without its env key unauthenticated and never picks it by default', async () => {
    const assembled = await assemble({});
    expect(assembled.providers.get('anthropic')?.usable).toBe(false);
    expect(assembled.fallbackProviders).not.toContain('anthropic');
    expect(() =>
      selectModel(
        assembled.models,
        undefined,
        undefined,
        assembled.fallbackProviders,
      ),
    ).toThrow(ModelSelectError);
  });

  it('marks a built-in usable from its documented env key', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const info = assembled.providers.get('anthropic');
    expect(info?.usable).toBe(true);
    expect(info?.authSource).toContain('ANTHROPIC_API_KEY');
    expect(assembled.providers.get('openai')?.usable).toBe(false);
    expect(assembled.fallbackProviders).toContain('anthropic');
    const picked = selectModel(
      assembled.models,
      undefined,
      undefined,
      assembled.fallbackProviders,
    );
    expect(picked.provider).toBe('anthropic');
  });

  it('selects a pinned built-in model ([model] provider="anthropic")', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const picked = selectModel(
      assembled.models,
      undefined,
      { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      assembled.fallbackProviders,
    );
    expect(`${picked.provider}/${picked.id}`).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('prefers a models.json provider over built-ins for the default pick', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            baseUrl: 'http://127.0.0.1:8000/v1',
            api: 'openai-completions',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      cwd,
      { ANTHROPIC_API_KEY: 'x', KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.fallbackProviders[0]).toBe('local');
    expect(assembled.providers.get('local')?.usable).toBe(true);
  });

  it('refuses a models.json provider whose id collides with a built-in, by name', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'anthropic',
            baseUrl: 'https://attacker.example/v1',
            api: 'openai-completions',
            models: [{ id: 'claude-sonnet-4-6' }],
          },
        ],
      }),
    );
    const before = (await assemble({})).models.getProvider(
      'anthropic',
    )?.baseUrl;
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.models.getProvider('anthropic')?.baseUrl).toBe(before);
    expect(assembled.notes.join('\n')).toMatch(
      /models\.json ignored: .*'anthropic'.*built-in/,
    );
  });

  it('`kubic models --json` lists built-ins with usable state, cost and thinking', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { json: true },
        {
          models: assembled.models,
          providers: assembled.providers,
          out: (l: string) => lines.push(l),
        },
      ),
    ).toBe(0);
    const catalog = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      usable: boolean;
      source: string;
      models: Array<{ id: string; thinking: string[]; inputCost: number }>;
    }>;
    const anthropic = catalog.find((p) => p.id === 'anthropic');
    expect(anthropic?.usable).toBe(true);
    expect(anthropic?.source).toBe('built-in');
    const sonnet = anthropic?.models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.inputCost).toBeGreaterThan(0);
    expect(sonnet?.thinking.length).toBeGreaterThan(0);
    expect(catalog.find((p) => p.id === 'openai')?.usable).toBe(false);
  });

  it('`kubic models` lists usable providers and summarises unconfigured built-ins', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const lines: string[] = [];
    await runModelsCommand(
      {},
      {
        models: assembled.models,
        providers: assembled.providers,
        out: (l: string) => lines.push(l),
      },
    );
    const text = lines.join('\n');
    expect(text).toMatch(/anthropic\s+claude-sonnet-4-6/);
    expect(text).not.toMatch(/^openai\s/m);
    expect(text).toMatch(
      /built-in providers not configured \(set their env key\): .*openai/,
    );
  });

  it('`kubic models --resolve anthropic/<id>` resolves a built-in', async () => {
    const assembled = await assemble({});
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { resolve: 'anthropic/claude-sonnet-4-6' },
        { models: assembled.models, out: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain('selected anthropic/claude-sonnet-4-6');
  });

  it('`kubic models --json` carries a custom model cache cost and input modalities (issue #223)', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: 'http://127.0.0.1:8000/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'vision',
                input: ['text', 'image'],
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
              },
            ],
          },
        },
      }),
    );
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    const lines: string[] = [];
    await runModelsCommand(
      { json: true },
      {
        models: assembled.models,
        providers: assembled.providers,
        out: (l: string) => lines.push(l),
      },
    );
    const catalog = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      models: Array<Record<string, unknown>>;
    }>;
    const vision = catalog.find((p) => p.id === 'local')?.models[0];
    expect(vision).toMatchObject({
      id: 'vision',
      input: ['text', 'image'],
      inputCost: 1,
      outputCost: 2,
      cacheReadCost: 0.1,
      cacheWriteCost: 1.25,
    });
  });
});

describe('provider key env index for worker grants (issue #200)', () => {
  it('maps a configured built-in to the env var its auth came from', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    expect(assembled.keyEnv.get('anthropic')).toEqual({
      envVars: ['ANTHROPIC_API_KEY'],
      noKeyNeeded: false,
    });
  });

  it('maps an unconfigured built-in to a registration with no deliverable key', async () => {
    const assembled = await assemble({});
    expect(assembled.keyEnv.get('anthropic')).toEqual({
      envVars: [],
      noKeyNeeded: false,
    });
  });

  it('maps a custom provider to its apiKeyEnv, defaulting to KUBIC_API_KEY', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: 'http://127.0.0.1:9000/v1',
            api: 'openai-completions',
            apiKeyEnv: 'GW_API_KEY',
            models: [{ id: 'm1' }],
          },
          {
            id: 'plain',
            baseUrl: 'http://127.0.0.1:9001/v1',
            api: 'openai-completions',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.keyEnv.get('gw')).toEqual({
      envVars: ['GW_API_KEY'],
      noKeyNeeded: false,
    });
    expect(assembled.keyEnv.get('plain')).toEqual({
      envVars: ['KUBIC_API_KEY'],
      noKeyNeeded: false,
    });
  });

  it('marks a literal-key custom provider as needing no env key', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'llama3' }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.keyEnv.get('local')).toEqual({
      envVars: [],
      noKeyNeeded: true,
    });
  });
});

// Issue #200 (§36.3): a worker is granted through the KUBIC_ROLE_* namespace
// under exact provider-key names; it never receives the operator's process
// environment. A built-in whose credential is process-level configuration
// (several vars, a profile, a region) therefore cannot be delivered in full,
// and the index says so by name instead of passing the manager's preflight
// and dying in the worker with `Provider is not configured`.
describe('provider key env index for multi-variable built-ins (issue #200)', () => {
  it('marks amazon-bedrock undeliverable for AWS access keys + region', async () => {
    const assembled = await assemble({
      AWS_ACCESS_KEY_ID: 'AKIA-test',
      AWS_SECRET_ACCESS_KEY: 'secret-test',
      AWS_REGION: 'us-east-1',
    });
    expect(assembled.providers.get('amazon-bedrock')?.authSource).toBe(
      'AWS access keys',
    );
    const entry = assembled.keyEnv.get('amazon-bedrock');
    expect(entry?.noKeyNeeded).toBe(false);
    expect(entry?.envVars).toEqual([]);
    expect(entry?.undeliverable).toContain('AWS_');
    expect(entry?.undeliverable).toContain('allowlist');
  });

  it('marks amazon-bedrock undeliverable even for a single-var bearer token or profile', async () => {
    for (const env of [
      { AWS_BEARER_TOKEN_BEDROCK: 'tok' },
      { AWS_PROFILE: 'work' },
    ]) {
      const entry = (await assemble(env)).keyEnv.get('amazon-bedrock');
      expect(entry?.undeliverable).toContain('AWS_');
      expect(entry?.envVars).toEqual([]);
    }
  });

  it('marks azure-openai-responses undeliverable: the base URL is process-level configuration', async () => {
    const entry = (
      await assemble({
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_BASE_URL: 'https://example.openai.azure.com',
      })
    ).keyEnv.get('azure-openai-responses');
    expect(entry?.noKeyNeeded).toBe(false);
    expect(entry?.envVars).toEqual([]);
    expect(entry?.undeliverable).toContain('AZURE_OPENAI_BASE_URL');
  });

  it('forwards GOOGLE_CLOUD_API_KEY for google-vertex: the key rides the grant view and needs no project or location', async () => {
    // Pi's Vertex auth returns `auth.apiKey` from the auth context (the grant
    // view) and `createClientWithApiKey` never reads project/location.
    const entry = (
      await assemble({
        GOOGLE_CLOUD_API_KEY: 'k',
        GOOGLE_CLOUD_PROJECT: 'p',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      })
    ).keyEnv.get('google-vertex');
    expect(entry).toEqual({
      envVars: ['GOOGLE_CLOUD_API_KEY'],
      noKeyNeeded: false,
    });
    const keyOnly = (await assemble({ GOOGLE_CLOUD_API_KEY: 'k' })).keyEnv.get(
      'google-vertex',
    );
    expect(keyOnly).toEqual({
      envVars: ['GOOGLE_CLOUD_API_KEY'],
      noKeyNeeded: false,
    });
  });

  it('marks google-vertex undeliverable when it authenticates from application default credentials: project and location are process-level configuration', async () => {
    const home = tmpDir();
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'gcloud', 'application_default_credentials.json'),
      '{}',
    );
    const assembled = await assembleModels(
      tmpDir(),
      { GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us-central1' },
      { home },
    );
    expect(assembled.providers.get('google-vertex')?.authSource).toBe(
      'gcloud application default credentials',
    );
    const entry = assembled.keyEnv.get('google-vertex');
    expect(entry?.noKeyNeeded).toBe(false);
    expect(entry?.envVars).toEqual([]);
    expect(entry?.undeliverable).toContain('GOOGLE_CLOUD_PROJECT');
    expect(entry?.undeliverable).toContain('GOOGLE_CLOUD_API_KEY');
  });

  it('a google-vertex with no credential at all is refused with the key remedy named', async () => {
    const entry = (await assemble({})).keyEnv.get('google-vertex');
    expect(entry?.envVars).toEqual([]);
    expect(entry?.undeliverable).toContain('GOOGLE_CLOUD_API_KEY');
  });

  it('forwards the account id next to the key for cloudflare-workers-ai', async () => {
    const entry = (
      await assemble({
        CLOUDFLARE_API_KEY: 'k',
        CLOUDFLARE_ACCOUNT_ID: 'acc',
      })
    ).keyEnv.get('cloudflare-workers-ai');
    expect(entry).toEqual({
      envVars: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
      noKeyNeeded: false,
    });
  });

  it('forwards the account and gateway ids next to the key for cloudflare-ai-gateway', async () => {
    const entry = (
      await assemble({
        CLOUDFLARE_API_KEY: 'k',
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_GATEWAY_ID: 'gw',
      })
    ).keyEnv.get('cloudflare-ai-gateway');
    expect(entry).toEqual({
      envVars: [
        'CLOUDFLARE_API_KEY',
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_GATEWAY_ID',
      ],
      noKeyNeeded: false,
    });
  });

  it('leaves a plain single-key built-in exactly as before', async () => {
    const entry = (await assemble({ OPENAI_API_KEY: 'k' })).keyEnv.get(
      'openai',
    );
    expect(entry).toEqual({ envVars: ['OPENAI_API_KEY'], noKeyNeeded: false });
    expect(entry).not.toHaveProperty('undeliverable');
  });
});

// Issue #402 (pi-ai 0.99.0): a catalogue entry now carries
// `type: 'chat' | 'image' | 'classifier'`, and ONLY the unqualified reads
// (`getModels`/`getModel`) stay chat-only. `kubic models` and model selection
// must never list or pick an image/classifier entry.
describe('chat-only model lists (issue #402)', () => {
  it('`kubic models --json` lists only chat models of a mixed catalogue', async () => {
    const assembled = await assemble({});
    // The chat-only read the CLI uses never yields a non-chat entry …
    for (const model of assembled.models.getModels()) {
      expect(model.type ?? 'chat').toBe('chat');
    }
    // … while the catalogue really is mixed: provider/getAllModels() holds
    // image and classifier entries (OpenRouter images, Cloudflare
    // classifiers). One upstream model may be BOTH chat and image under the
    // same id, so only the ids that exist as non-chat entries and are missing
    // from the chat read prove a filter.
    const nonChatOnly = new Set<string>();
    for (const provider of assembled.models.getProviders()) {
      const chatIds = new Set(
        assembled.models.getModels(provider.id).map((model) => model.id),
      );
      for (const model of assembled.models.getAllModels(provider.id)) {
        if ((model.type ?? 'chat') !== 'chat' && !chatIds.has(model.id)) {
          nonChatOnly.add(`${provider.id}/${model.id}`);
        }
      }
    }
    expect(nonChatOnly.size).toBeGreaterThan(0);
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { json: true },
        {
          models: assembled.models,
          providers: assembled.providers,
          out: (line: string) => lines.push(line),
        },
      ),
    ).toBe(0);
    const catalog = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      models: Array<{ id: string }>;
    }>;
    const listed = catalog.flatMap((provider) =>
      provider.models.map((model) => `${provider.id}/${model.id}`),
    );
    expect(listed.length).toBeGreaterThan(0);
    for (const ref of listed) expect(nonChatOnly.has(ref)).toBe(false);
    // And the listing is exactly the chat read, provider by provider.
    for (const provider of catalog) {
      expect(provider.models.map((model) => model.id)).toEqual(
        assembled.models.getModels(provider.id).map((model) => model.id),
      );
    }
  });

  it('model selection resolves and picks only chat models', async () => {
    const assembled = await assemble({ OPENROUTER_API_KEY: 'k' });
    const chatIds = new Set(
      assembled.models.getModels('openrouter').map((model) => model.id),
    );
    const nonChatOnly = assembled.models
      .getAllModels('openrouter')
      .find(
        (model) => (model.type ?? 'chat') !== 'chat' && !chatIds.has(model.id),
      );
    expect(nonChatOnly).toBeDefined();
    // An unqualified lookup never finds a non-chat-only model …
    expect(
      assembled.models.getModel('openrouter', nonChatOnly?.id as string),
    ).toBe(undefined);
    // … and the implicit pick is a chat model.
    const picked = selectModel(assembled.models, undefined, undefined, [
      'openrouter',
    ]);
    expect(picked.type ?? 'chat').toBe('chat');
    expect(chatIds.has(picked.id)).toBe(true);
  });
});

// Issue #402 (pi-ai 0.99.2): Anthropic workload identity federation. Pi's
// provider resolves it only when no stored credential or key is configured,
// from three required ANTHROPIC_* variables (plus two optional ids) read
// through the auth context — the same context a worker's role grant feeds, so
// the whole block IS deliverable.
describe('Anthropic workload identity federation (issue #402)', () => {
  const FEDERATION_ENV = {
    ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_123',
    ANTHROPIC_ORGANIZATION_ID: 'org_123',
    ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/anthropic-identity-token',
  };

  it('reports Anthropic configured from federation env alone, in models and doctor', async () => {
    const assembled = await assemble(FEDERATION_ENV);
    const info = assembled.providers.get('anthropic');
    expect(info?.usable).toBe(true);
    expect(info?.authSource).toBe('workload identity federation');
    expect(assembled.providers.get('openai')?.usable).toBe(false);
    expect(assembled.fallbackProviders).toContain('anthropic');
    expect(providerProbesOf(assembled).map((probe) => probe.id)).toContain(
      'anthropic',
    );
    const lines: string[] = [];
    await runModelsCommand(
      { json: true },
      {
        models: assembled.models,
        providers: assembled.providers,
        out: (line: string) => lines.push(line),
      },
    );
    const catalog = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      usable: boolean;
      auth?: string;
    }>;
    const anthropic = catalog.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.usable).toBe(true);
    expect(anthropic?.auth).toBe('workload identity federation');
  });

  it('needs the whole required trio: a partial block is not Anthropic auth', async () => {
    const partial = [
      {
        ANTHROPIC_ORGANIZATION_ID: 'org_123',
        ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/token',
      },
      {
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_123',
        ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/secrets/token',
      },
      {
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_123',
        ANTHROPIC_ORGANIZATION_ID: 'org_123',
      },
    ];
    for (const env of partial) {
      expect((await assemble(env)).providers.get('anthropic')?.usable).toBe(
        false,
      );
    }
  });

  it('forwards the federation block as the worker grant: the required trio, plus the optional ids when set', async () => {
    expect((await assemble(FEDERATION_ENV)).keyEnv.get('anthropic')).toEqual({
      envVars: [
        'ANTHROPIC_FEDERATION_RULE_ID',
        'ANTHROPIC_ORGANIZATION_ID',
        'ANTHROPIC_IDENTITY_TOKEN_FILE',
      ],
      noKeyNeeded: false,
    });
    expect(
      (
        await assemble({
          ...FEDERATION_ENV,
          ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_123',
          ANTHROPIC_WORKSPACE_ID: 'wrkspc_123',
        })
      ).keyEnv.get('anthropic'),
    ).toEqual({
      envVars: [
        'ANTHROPIC_FEDERATION_RULE_ID',
        'ANTHROPIC_ORGANIZATION_ID',
        'ANTHROPIC_IDENTITY_TOKEN_FILE',
        'ANTHROPIC_SERVICE_ACCOUNT_ID',
        'ANTHROPIC_WORKSPACE_ID',
      ],
      noKeyNeeded: false,
    });
  });

  it('a worker that receives the federation grant resolves Anthropic as configured', async () => {
    const assembled = await assemble(FEDERATION_ENV);
    const resolved = resolveProviderGrant('anthropic', {
      keyEnv: assembled.keyEnv,
      env: FEDERATION_ENV,
    });
    expect(resolved.kind).toBe('grant');
    if (resolved.kind !== 'grant') return;
    const spawned = buildSpawnEnv({ PATH: '/bin' }, 'worker', resolved.grant);
    expect(Object.keys(spawned).sort()).toEqual([
      'KUBIC_ROLE_WORKER_ANTHROPIC_FEDERATION_RULE_ID',
      'KUBIC_ROLE_WORKER_ANTHROPIC_IDENTITY_TOKEN_FILE',
      'KUBIC_ROLE_WORKER_ANTHROPIC_ORGANIZATION_ID',
      'PATH',
    ]);
    const child = await assemble(withRoleGrant(spawned, 'worker'));
    expect(child.providers.get('anthropic')?.usable).toBe(true);
    expect(child.providers.get('anthropic')?.authSource).toBe(
      'workload identity federation',
    );
  });
});
