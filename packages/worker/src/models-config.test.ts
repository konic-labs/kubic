// Models.json custom/local providers.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from './compaction.js';
import {
  ModelsJsonError,
  parseModelsJson,
  registerCustomProviders,
} from './models-config.js';
import { createModels } from './pi-boundary.js';
import { LOCAL_MODELS_EXAMPLE } from './test-support/models-fixtures.js';

describe('models.json apiKeyEnv allowlist', () => {
  const withKeyEnv = (apiKeyEnv: string) => ({
    providers: [
      {
        id: 'gw',
        baseUrl: 'http://127.0.0.1:8000/v1',
        api: 'openai-completions',
        apiKeyEnv,
        models: [{ id: 'm' }],
      },
    ],
  });

  it.each([
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'HOME',
    'PATH',
    'kubic_lower_api_key',
  ])('refuses apiKeyEnv %s with a ModelsJsonError naming it', (name) => {
    expect(() => parseModelsJson(withKeyEnv(name))).toThrow(ModelsJsonError);
    expect(() => parseModelsJson(withKeyEnv(name))).toThrow(name);
  });

  it.each([
    'KUBIC_API_KEY',
    'KUBIC_GATEWAY_TOKEN',
    'OPENROUTER_API_KEY',
    'MY_GATEWAY_API_KEY',
  ])('accepts apiKeyEnv %s', (name) => {
    expect(parseModelsJson(withKeyEnv(name))[0]?.apiKeyEnv).toBe(name);
  });
});

describe('models.json custom providers', () => {
  it('parses an Ollama-style local provider', () => {
    const specs = parseModelsJson({
      providers: [
        {
          id: 'local',
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          models: [{ id: 'llama3' }],
        },
      ],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.id).toBe('local');
    expect(specs[0]?.models[0]?.id).toBe('llama3');
  });

  it('the local example loads verbatim', () => {
    const specs = parseModelsJson(LOCAL_MODELS_EXAMPLE);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.models.length).toBeGreaterThan(0);
  });

  it('rejects bad specs with named reasons', () => {
    expect(() => parseModelsJson({ providers: [] })).toThrow(/non-empty/);
    expect(() =>
      parseModelsJson({
        providers: [
          { id: 'x', api: 'openai-completions', models: [{ id: 'm' }] },
        ],
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      parseModelsJson({
        providers: [
          { id: 'x', baseUrl: 'http://y', api: 'nope', models: [{ id: 'm' }] },
        ],
      }),
    ).toThrow(/api/);
    expect(() =>
      parseModelsJson({
        providers: [
          {
            id: '-bad',
            baseUrl: 'http://y',
            api: 'openai-completions',
            models: [{ id: 'm' }],
          },
        ],
      }),
    ).toThrow(/id/);
    expect(() =>
      parseModelsJson({
        providers: [
          {
            id: 'x',
            baseUrl: 'ftp://y',
            api: 'openai-completions',
            models: [{ id: 'm' }],
          },
        ],
      }),
    ).toThrow(/http/);
    expect(() =>
      parseModelsJson({
        providers: [
          {
            id: 'x',
            baseUrl: 'http://y',
            api: 'openai-completions',
            models: [{ id: 'm' }, { id: 'm' }],
          },
        ],
      }),
    ).toThrow(/duplicate model/);
  });

  it('registers custom providers without network', () => {
    const models = createModels();
    const names = registerCustomProviders(
      models,
      parseModelsJson(LOCAL_MODELS_EXAMPLE),
    );
    expect(names).toEqual(['local']);
    expect(models.getProvider('local')?.id).toBe('local');
    expect(models.getModels('local').map((m) => m.id)).toContain('llama3');
  });

  // Smoke follow-up: gateways like opencode-go require a
  // per-provider header (x-opencode-session) on every request — pi-ai's
  // createProvider accepts static ProviderHeaders, so models.json passes
  // them through instead of kubic hard-coding any gateway.
  it('threads a per-provider headers map into the created provider', () => {
    const models = createModels();
    const specs = parseModelsJson({
      providers: [
        {
          id: 'opencode-go',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          api: 'openai-completions',
          headers: {
            'x-opencode-session': 'kubic-session-1',
            'x-opencode-client': 'kubic',
          },
          models: [{ id: 'deepseek-v4.1-flash' }],
        },
      ],
    });
    expect(specs[0]?.headers).toEqual({
      'x-opencode-session': 'kubic-session-1',
      'x-opencode-client': 'kubic',
    });
    registerCustomProviders(models, specs);
    expect(models.getProvider('opencode-go')?.headers).toEqual({
      'x-opencode-session': 'kubic-session-1',
      'x-opencode-client': 'kubic',
    });
    // The stream path merges MODEL-level headers into requests, so the
    // provider map must ride on each model too.
    expect(models.getModels('opencode-go')[0]?.headers).toEqual({
      'x-opencode-session': 'kubic-session-1',
      'x-opencode-client': 'kubic',
    });
  });

  it('rejects a non-string header value with a named reason', () => {
    expect(() =>
      parseModelsJson({
        providers: [
          {
            id: 'x',
            baseUrl: 'https://x.example/v1',
            api: 'openai-completions',
            headers: { 'x-bad': 42 },
            models: [{ id: 'm' }],
          },
        ],
      }),
    ).toThrow(/headers/);
  });
});

describe('models.json defaults (compaction headroom)', () => {
  it('keeps the fail-safe 8192/2048 defaults and still leaves compaction headroom', () => {
    const models = createModels();
    registerCustomProviders(
      models,
      parseModelsJson({
        providers: [
          {
            id: 'fake',
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            models: [{ id: 'm' }],
          },
        ],
      }),
    );
    const model = models.getModels('fake')[0];
    expect(model?.contextWindow).toBe(8192);
    expect(model?.maxTokens).toBe(2048);
    // The reserve clamp keeps the threshold positive for the small default
    // window (otherwise every turn compacts: one extra model call each).
    const window = model?.contextWindow ?? 0;
    expect(
      window - effectiveReserveTokens(window, DEFAULT_RESERVE_TOKENS),
    ).toBeGreaterThan(0);
  });
});

// A models.json provider key is resolved at
// REQUEST time through the host's resolver hook, once per auth resolution,
// so each use can be audited. Availability checks never resolve (and so
// never count as a use).
describe('models.json request-time key resolution', () => {
  const spec = parseModelsJson({
    providers: [
      {
        id: 'gw',
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        apiKeyEnv: 'GW_API_KEY',
        models: [{ id: 'm1' }],
      },
    ],
  });
  const env: Record<string, string> = { GW_API_KEY: 'sk-live-gw-123' };
  const ctx = {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
  const signal = new AbortController().signal;

  it('routes every resolve through the hook and never on check', async () => {
    const calls: { provider: string; envVar: string }[] = [];
    const models = createModels();
    registerCustomProviders(models, spec, {
      resolveApiKey: async (use) => {
        if (!('envVar' in use)) throw new Error('expected a legacy env use');
        calls.push({ provider: use.provider, envVar: use.envVar });
        return use.readEnv(use.envVar);
      },
    });
    const auth = models.getProvider('gw')?.auth.apiKey;
    if (auth === undefined) throw new Error('no api key auth');
    expect(await auth.check?.({ ctx, signal })).toEqual({
      source: 'GW_API_KEY',
      type: 'api_key',
    });
    expect(calls).toEqual([]);
    const first = await auth.resolve({ ctx, signal });
    const second = await auth.resolve({ ctx, signal });
    expect(first?.auth.apiKey).toBe('sk-live-gw-123');
    expect(second?.source).toBe('GW_API_KEY');
    expect(calls).toEqual([
      { provider: 'gw', envVar: 'GW_API_KEY' },
      { provider: 'gw', envVar: 'GW_API_KEY' },
    ]);
  });

  it('an unset key is not configured: no hook use, check reports nothing', async () => {
    const calls: string[] = [];
    const models = createModels();
    registerCustomProviders(models, spec, {
      resolveApiKey: async (use) => {
        if (!('envVar' in use)) throw new Error('expected a legacy env use');
        calls.push(use.envVar);
        return use.readEnv(use.envVar);
      },
    });
    const auth = models.getProvider('gw')?.auth.apiKey;
    const empty = { env: async () => undefined, fileExists: async () => false };
    expect(await auth?.check?.({ ctx: empty, signal })).toBeUndefined();
    expect(await auth?.resolve({ ctx: empty, signal })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

// `apiKey` and header ref forms resolve per request
// through the same hook — env reads, command runs (rerun every request,
// never on the side-effect-free check), escaped literals never touching it.
// Zero network: auth envelopes only, never a request.
describe('models.json request-time ref resolution', () => {
  const env: Record<string, string> = {
    GW_API_KEY: 'sk-ref-env-12345678',
    KUBIC_GATEWAY_TOKEN: 'gw-header-token-12345678',
  };
  const ctx = {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
  const signal = new AbortController().signal;

  // The $VAR fixture is allowlisted.
  function hook() {
    const calls: Array<{ provider: string; raw: string }> = [];
    const values: Record<string, string> = {
      $GW_API_KEY: 'sk-ref-env-12345678',
      $KUBIC_GATEWAY_TOKEN: 'gw-header-token-12345678',
      '!echo hello': 'hello',
    };
    return {
      calls,
      resolveApiKey: async (use: {
        provider: string;
        ref: { raw: string };
        readEnv: (name: string) => Promise<string | undefined>;
      }) => {
        calls.push({ provider: use.provider, raw: use.ref.raw });
        return values[use.ref.raw];
      },
    };
  }

  function providerWith(extra: Record<string, unknown>) {
    return parseModelsJson({
      providers: [
        {
          id: 'ref',
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          models: [{ id: 'm1' }],
          ...extra,
        },
      ],
    });
  }

  it('resolves apiKey "$GW_API_KEY" per request; missing names the hook error', async () => {
    const h = hook();
    const models = createModels();
    registerCustomProviders(models, providerWith({ apiKey: '$GW_API_KEY' }), {
      resolveApiKey: h.resolveApiKey as never,
    });
    const auth = models.getProvider('ref')?.auth.apiKey;
    if (auth === undefined) throw new Error('no api key auth');
    expect(await auth.check?.({ ctx, signal })).toEqual({
      source: 'GW_API_KEY',
      type: 'api_key',
    });
    expect(h.calls).toEqual([]);
    const first = await auth.resolve({ ctx, signal });
    expect(first?.auth.apiKey).toBe('sk-ref-env-12345678');
    expect(first?.source).toBe('GW_API_KEY');
    await auth.resolve({ ctx, signal });
    expect(h.calls).toEqual([
      { provider: 'ref', raw: '$GW_API_KEY' },
      { provider: 'ref', raw: '$GW_API_KEY' },
    ]);
  });

  it('runs the apiKey command on every resolve, never on check', async () => {
    const h = hook();
    const models = createModels();
    registerCustomProviders(models, providerWith({ apiKey: '!echo hello' }), {
      resolveApiKey: h.resolveApiKey as never,
    });
    const auth = models.getProvider('ref')?.auth.apiKey;
    if (auth === undefined) throw new Error('no api key auth');
    expect(await auth.check?.({ ctx, signal })).toEqual({
      source: '!echo',
      type: 'api_key',
    });
    expect(h.calls).toEqual([]);
    const resolved = await auth.resolve({ ctx, signal });
    expect(resolved?.auth.apiKey).toBe('hello');
  });

  it('serves an escaped apiKey literal without the hook', async () => {
    const h = hook();
    const models = createModels();
    registerCustomProviders(models, providerWith({ apiKey: '\\$literal' }), {
      resolveApiKey: h.resolveApiKey as never,
    });
    const auth = models.getProvider('ref')?.auth.apiKey;
    expect((await auth?.resolve({ ctx, signal }))?.auth.apiKey).toBe(
      '$literal',
    );
    expect(h.calls).toEqual([]);
  });

  it('resolves header refs into auth.headers, keeping literals static', async () => {
    const h = hook();
    const models = createModels();
    const specs = providerWith({
      apiKey: 'not-needed',
      headers: {
        'x-static': 'kubic',
        'x-token': '$KUBIC_GATEWAY_TOKEN',
      },
    });
    registerCustomProviders(models, specs, {
      resolveApiKey: h.resolveApiKey as never,
    });
    expect(models.getProvider('ref')?.headers).toEqual({
      'x-static': 'kubic',
    });
    const auth = models.getProvider('ref')?.auth.apiKey;
    if (auth === undefined) throw new Error('no api key auth');
    expect(await auth.check?.({ ctx, signal })).not.toBeUndefined();
    expect(h.calls).toEqual([]);
    const resolved = await auth.resolve({ ctx, signal });
    expect(resolved?.auth.apiKey).toBe('not-needed');
    expect(resolved?.auth.headers).toEqual({
      'x-token': 'gw-header-token-12345678',
    });
  });

  it('without a hook, env refs read env-direct and commands fail named', async () => {
    const models = createModels();
    registerCustomProviders(
      models,
      providerWith({ apiKey: '!vault kv get -field=password secret/api' }),
    );
    const auth = models.getProvider('ref')?.auth.apiKey;
    if (auth === undefined) throw new Error('no api key auth');
    expect(await auth.check?.({ ctx, signal })).not.toBeUndefined();
    await expect(auth.resolve({ ctx, signal })).rejects.toThrow(
      /secret-command runner/,
    );
    const direct = createModels();
    registerCustomProviders(direct, providerWith({ apiKey: '$GW_API_KEY' }));
    const directAuth = direct.getProvider('ref')?.auth.apiKey;
    expect((await directAuth?.resolve({ ctx, signal }))?.auth.apiKey).toBe(
      'sk-ref-env-12345678',
    );
  });
});
