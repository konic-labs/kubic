// models.json custom/local providers (issue #20, slice A; §37, §38.5).
// Kubic parses + validates models.json; Pi's createProvider builds the
// provider (streaming, auth, cost stay in Pi's model layer — the registry
// is generated, never hand-edited). Only OpenAI-compatible APIs are
// supported for custom endpoints (Ollama-style local path); anything else
// is refused with a named reason, never silently mapped.

import {
  createProvider,
  envApiKeyAuth,
  openAICompletionsApiLazy,
  openAIResponsesApiLazy,
  type MutableModels,
} from './pi-boundary.js';

export const CUSTOM_APIS = ['openai-completions', 'openai-responses'] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

export interface CustomModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputCost?: number;
  outputCost?: number;
  reasoning?: boolean;
}

export interface CustomProviderSpec {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  api: CustomApi;
  models: CustomModelSpec[];
}

export class ModelsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelsJsonError';
  }
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelsJsonError(`${what}: '${key}' must be a non-empty string`);
  }
  return value;
}

function optNumber(record: Record<string, unknown>, key: string, what: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ModelsJsonError(`${what}: '${key}' must be a non-negative number`);
  }
  return value;
}

function parseModel(raw: unknown, providerId: string): CustomModelSpec {
  if (!isRecord(raw)) throw new ModelsJsonError(`provider '${providerId}': model must be an object`);
  const id = reqString(raw, 'id', `provider '${providerId}' model`);
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}),
    ...(optNumber(raw, 'contextWindow', `model '${id}'`) === undefined
      ? {}
      : { contextWindow: optNumber(raw, 'contextWindow', `model '${id}'`) as number }),
    ...(optNumber(raw, 'maxTokens', `model '${id}'`) === undefined
      ? {}
      : { maxTokens: optNumber(raw, 'maxTokens', `model '${id}'`) as number }),
    ...(optNumber(raw, 'inputCost', `model '${id}'`) === undefined
      ? {}
      : { inputCost: optNumber(raw, 'inputCost', `model '${id}'`) as number }),
    ...(optNumber(raw, 'outputCost', `model '${id}'`) === undefined
      ? {}
      : { outputCost: optNumber(raw, 'outputCost', `model '${id}'`) as number }),
    ...(raw.reasoning === true ? { reasoning: true as const } : {}),
  };
}

function parseProvider(raw: unknown): CustomProviderSpec {
  if (!isRecord(raw)) throw new ModelsJsonError('provider must be an object');
  const id = reqString(raw, 'id', 'provider');
  if (!PROVIDER_ID.test(id)) {
    throw new ModelsJsonError(`provider id '${id}' must match ${PROVIDER_ID}`);
  }
  const baseUrl = reqString(raw, 'baseUrl', `provider '${id}'`);
  const api = raw.api;
  if (api !== 'openai-completions' && api !== 'openai-responses') {
    throw new ModelsJsonError(
      `provider '${id}': api must be 'openai-completions' or 'openai-responses' (got ${JSON.stringify(api)})`,
    );
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new ModelsJsonError(`provider '${id}': models must be a non-empty array`);
  }
  const apiKeyEnv = raw.apiKeyEnv;
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '')) {
    throw new ModelsJsonError(`provider '${id}': apiKeyEnv must be a non-empty string when set`);
  }
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}),
    baseUrl,
    ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}),
    api,
    models: raw.models.map((m) => parseModel(m, id)),
  };
}

export function parseModelsJson(raw: unknown): CustomProviderSpec[] {
  if (!isRecord(raw)) throw new ModelsJsonError('models.json must be an object with a providers array');
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new ModelsJsonError('models.json providers must be a non-empty array');
  }
  const seen = new Set<string>();
  const specs = raw.providers.map((p) => parseProvider(p));
  for (const spec of specs) {
    if (seen.has(spec.id)) throw new ModelsJsonError(`duplicate provider id '${spec.id}'`);
    seen.add(spec.id);
  }
  return specs;
}

// §38.5 local example: loads verbatim (pinned by test). Local-first,
// zero paid tokens — the CI-safe provider.
export const LOCAL_MODELS_EXAMPLE = {
  providers: [
    {
      id: 'local',
      name: 'Local (Ollama-style)',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'llama3',
          name: 'Llama 3 (local)',
          contextWindow: 8192,
          maxTokens: 2048,
          inputCost: 0,
          outputCost: 0,
        },
      ],
    },
  ],
} as const;

export function registerCustomProviders(
  models: MutableModels,
  specs: CustomProviderSpec[],
): string[] {
  const names: string[] = [];
  for (const spec of specs) {
    const key = spec.apiKeyEnv ?? 'KUBIC_API_KEY';
    const provider = createProvider({
      id: spec.id,
      ...(spec.name === undefined ? {} : { name: spec.name }),
      baseUrl: spec.baseUrl,
      auth: {
        apiKey: envApiKeyAuth(`${spec.id} API key`, [key]),
      },
      models: spec.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: spec.api,
        provider: spec.id,
        baseUrl: spec.baseUrl,
        reasoning: m.reasoning ?? false,
        input: ['text'] as ('text' | 'image')[],
        cost: {
          input: m.inputCost ?? 0,
          output: m.outputCost ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: m.contextWindow ?? 8192,
        maxTokens: m.maxTokens ?? 2048,
      })),
      api:
        spec.api === 'openai-completions'
          ? openAICompletionsApiLazy()
          : openAIResponsesApiLazy(),
    });
    models.setProvider(provider);
    names.push(spec.id);
  }
  return names;
}
