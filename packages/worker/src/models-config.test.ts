// Slice A: models.json custom/local providers (issue #20; §37).
// RED: parseModelsJson/registerCustomProviders do not exist yet.
import { describe, expect, it } from 'vitest';
import {
  LOCAL_MODELS_EXAMPLE,
  parseModelsJson,
  registerCustomProviders,
} from './models-config.js';
import { createModels } from './pi-boundary.js';

describe('models.json custom providers (issue #20, slice A)', () => {
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

  it('the §38.5 local example loads verbatim', () => {
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

  // Issue #113 smoke follow-up: gateways like opencode-go require a
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
