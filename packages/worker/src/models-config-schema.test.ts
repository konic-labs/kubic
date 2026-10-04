// models.json schema (issue #223; §38.5, §37.2, §39, §27.1): the spec's
// object form, cache costs, input modalities, and validated
// contextWindow/maxTokens. Zero network: registration only.
import { describe, expect, it } from 'vitest';
import {
  ModelsJsonError,
  parseModelsJson,
  registerCustomProviders,
} from './models-config.js';
import { createModels } from './pi-boundary.js';

// docs/design/kubic-overview.md §38.5, verbatim.
const SPEC_38_5 = `{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "models": [
        { "id": "qwen3-coder-27b", "contextWindow": 131072, "maxTokens": 16384 }
      ]
    }
  }
}`;

function one(model: Record<string, unknown>) {
  return {
    providers: {
      p: {
        baseUrl: 'http://127.0.0.1:8000/v1',
        api: 'openai-completions',
        models: [{ id: 'm', ...model }],
      },
    },
  };
}

function withProvider(extra: Record<string, unknown>) {
  return {
    providers: {
      p: {
        baseUrl: 'http://127.0.0.1:8000/v1',
        api: 'openai-completions',
        models: [{ id: 'm' }],
        ...extra,
      },
    },
  };
}

describe('models.json schema (issue #223)', () => {
  it('parses and registers the §38.5 block as written', async () => {
    const specs = parseModelsJson(JSON.parse(SPEC_38_5));
    expect(specs.map((s) => s.id)).toEqual(['local']);
    const models = createModels();
    registerCustomProviders(models, specs);
    const model = models.getModel('local', 'qwen3-coder-27b');
    expect(model?.contextWindow).toBe(131072);
    expect(model?.maxTokens).toBe(16384);
    // The literal apiKey is the provider's key.
    const auth = await models.getAuth('local');
    expect(auth?.auth.apiKey).toBe('not-needed');
  });

  it('keeps the array form as an alias', () => {
    const specs = parseModelsJson({
      providers: [
        {
          id: 'a',
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          models: [{ id: 'm' }],
        },
      ],
    });
    expect(specs[0]?.id).toBe('a');
  });

  it('refuses an object-form entry whose id disagrees with its key', () => {
    expect(() =>
      parseModelsJson({
        providers: {
          a: {
            id: 'b',
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            models: [{ id: 'm' }],
          },
        },
      }),
    ).toThrow(ModelsJsonError);
  });

  it('refuses an empty providers object', () => {
    expect(() => parseModelsJson({ providers: {} })).toThrow(/non-empty/);
  });

  it('carries cost.cacheRead/cacheWrite into Model.cost', () => {
    const models = createModels();
    registerCustomProviders(
      models,
      parseModelsJson(
        one({
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        }),
      ),
    );
    expect(models.getModel('p', 'm')?.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it('refuses a cost given both flat and in the cost object', () => {
    expect(() =>
      parseModelsJson(one({ inputCost: 1, cost: { input: 2 } })),
    ).toThrow(/inputCost/);
  });

  it('carries input modalities into the registered model', () => {
    const models = createModels();
    registerCustomProviders(
      models,
      parseModelsJson(one({ input: ['text', 'image'] })),
    );
    expect(models.getModel('p', 'm')?.input).toEqual(['text', 'image']);
    expect(() => parseModelsJson(one({ input: ['audio'] }))).toThrow(/'input'/);
    expect(() => parseModelsJson(one({ input: [] }))).toThrow(/'input'/);
  });

  it.each([
    [{ contextWindow: 0 }, 'contextWindow'],
    [{ contextWindow: 8192.5 }, 'contextWindow'],
    [{ maxTokens: 0 }, 'maxTokens'],
    [{ maxTokens: 1.5 }, 'maxTokens'],
    [{ contextWindow: 4096, maxTokens: 8192 }, 'maxTokens'],
    [{ contextWindow: 4096, maxTokens: 4096 }, 'maxTokens'],
    [{ contextWindow: 1024 }, 'maxTokens'],
  ])('refuses %j naming %s', (model, field) => {
    expect(() => parseModelsJson(one(model))).toThrow(ModelsJsonError);
    expect(() => parseModelsJson(one(model))).toThrow(`'${field}'`);
  });

  it('refuses a secret-ref apiKey, and apiKey together with apiKeyEnv', () => {
    expect(() =>
      parseModelsJson(withProvider({ apiKey: '$OPENAI_API_KEY' })),
    ).toThrow(/apiKey/);
    expect(() =>
      parseModelsJson(
        withProvider({ apiKey: 'x', apiKeyEnv: 'KUBIC_API_KEY' }),
      ),
    ).toThrow(/apiKey/);
  });

  // Issue #402 (pi-ai 1.0.2): the model-level sampling defaults Pi resolves
  // per effective thinking level. Forwarded as declared — Pi merges the
  // level's object over the model default at request time.
  it('carries samplingParams and samplingParamsByThinkingLevel onto the model', () => {
    const models = createModels();
    registerCustomProviders(
      models,
      parseModelsJson(
        one({
          samplingParams: { temperature: 0.2, top_p: 0.9 },
          samplingParamsByThinkingLevel: {
            high: { temperature: 1, top_p: 1 },
            off: { temperature: 0 },
          },
        }),
      ),
    );
    const model = models.getModel('p', 'm');
    expect(model?.samplingParams).toEqual({ temperature: 0.2, top_p: 0.9 });
    expect(model?.samplingParamsByThinkingLevel).toEqual({
      high: { temperature: 1, top_p: 1 },
      off: { temperature: 0 },
    });
  });

  it('refuses malformed sampling params by field name', () => {
    expect(() => parseModelsJson(one({ samplingParams: 0.5 }))).toThrow(
      /'samplingParams'/,
    );
    expect(() => parseModelsJson(one({ samplingParams: [1] }))).toThrow(
      /'samplingParams'/,
    );
    expect(() =>
      parseModelsJson(one({ samplingParamsByThinkingLevel: { often: {} } })),
    ).toThrow(/samplingParamsByThinkingLevel/);
    expect(() =>
      parseModelsJson(one({ samplingParamsByThinkingLevel: { high: 1 } })),
    ).toThrow(/samplingParamsByThinkingLevel/);
    expect(() =>
      parseModelsJson(one({ samplingParamsByThinkingLevel: [] })),
    ).toThrow(/samplingParamsByThinkingLevel/);
  });
});
