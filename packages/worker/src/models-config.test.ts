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
});
