// models.json custom/local providers (issue #20, slice A; §37, §38.5).
// Kubic parses + validates models.json; Pi's createProvider builds the
// provider (streaming, auth, cost stay in Pi's model layer — the registry
// is generated, never hand-edited). Only OpenAI-compatible APIs are
// supported for custom endpoints (Ollama-style local path); anything else
// is refused with a named reason, never silently mapped.

import {
  createProvider,
  envApiKeyAuth,
  type ModelThinkingLevel,
  type MutableModels,
  openAICompletionsApiLazy,
  openAIResponsesApiLazy,
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
  /** Static per-provider headers (e.g. opencode-go's x-opencode-session). */
  headers?: Record<string, string>;
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

function reqString(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelsJsonError(`${what}: '${key}' must be a non-empty string`);
  }
  return value;
}

function optNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ModelsJsonError(
      `${what}: '${key}' must be a non-negative number`,
    );
  }
  return value;
}

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return (
    typeof value === 'string' &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

function parseModel(raw: unknown, providerId: string): CustomModelSpec {
  if (!isRecord(raw))
    throw new ModelsJsonError(
      `provider '${providerId}': model must be an object`,
    );
  const id = reqString(raw, 'id', `provider '${providerId}' model`);
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== ''
      ? { name: raw.name }
      : {}),
    ...(optNumber(raw, 'contextWindow', `model '${id}'`) === undefined
      ? {}
      : {
          contextWindow: optNumber(
            raw,
            'contextWindow',
            `model '${id}'`,
          ) as number,
        }),
    ...(optNumber(raw, 'maxTokens', `model '${id}'`) === undefined
      ? {}
      : { maxTokens: optNumber(raw, 'maxTokens', `model '${id}'`) as number }),
    ...(optNumber(raw, 'inputCost', `model '${id}'`) === undefined
      ? {}
      : { inputCost: optNumber(raw, 'inputCost', `model '${id}'`) as number }),
    ...(optNumber(raw, 'outputCost', `model '${id}'`) === undefined
      ? {}
      : {
          outputCost: optNumber(raw, 'outputCost', `model '${id}'`) as number,
        }),
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
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ModelsJsonError(
        `provider '${id}': baseUrl must be http(s) (got ${JSON.stringify(baseUrl)})`,
      );
    }
  } catch (error) {
    if (error instanceof ModelsJsonError) throw error;
    throw new ModelsJsonError(
      `provider '${id}': baseUrl must be a valid URL (got ${JSON.stringify(baseUrl)})`,
    );
  }
  const api = raw.api;
  if (api !== 'openai-completions' && api !== 'openai-responses') {
    throw new ModelsJsonError(
      `provider '${id}': api must be 'openai-completions' or 'openai-responses' (got ${JSON.stringify(api)})`,
    );
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new ModelsJsonError(
      `provider '${id}': models must be a non-empty array`,
    );
  }
  const apiKeyEnv = raw.apiKeyEnv;
  if (
    apiKeyEnv !== undefined &&
    (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '')
  ) {
    throw new ModelsJsonError(
      `provider '${id}': apiKeyEnv must be a non-empty string when set`,
    );
  }
  // Static per-provider headers (gateways like opencode-go require one on
  // every request). Keys and values must both be non-empty strings — a
  // malformed map is a named refusal, never a silent drop.
  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) {
      throw new ModelsJsonError(
        `provider '${id}': headers must be an object of string to string`,
      );
    }
    for (const [key, value] of Object.entries(raw.headers)) {
      if (
        typeof key !== 'string' ||
        key === '' ||
        typeof value !== 'string' ||
        value === ''
      ) {
        throw new ModelsJsonError(
          `provider '${id}': headers keys and values must be non-empty strings (got ${JSON.stringify(key)}: ${JSON.stringify(value)})`,
        );
      }
    }
    headers = { ...(raw.headers as Record<string, string>) };
  }
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== ''
      ? { name: raw.name }
      : {}),
    baseUrl,
    ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}),
    ...(headers === undefined ? {} : { headers }),
    api,
    models: raw.models.map((m) => parseModel(m, id)),
  };
}

export function parseModelsJson(raw: unknown): CustomProviderSpec[] {
  if (!isRecord(raw))
    throw new ModelsJsonError(
      'models.json must be an object with a providers array',
    );
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new ModelsJsonError(
      'models.json providers must be a non-empty array',
    );
  }
  const seen = new Set<string>();
  const specs = raw.providers.map((p) => parseProvider(p));
  for (const spec of specs) {
    if (seen.has(spec.id))
      throw new ModelsJsonError(`duplicate provider id '${spec.id}'`);
    seen.add(spec.id);
    const modelIds = new Set<string>();
    for (const m of spec.models) {
      if (modelIds.has(m.id)) {
        throw new ModelsJsonError(
          `provider '${spec.id}': duplicate model id '${m.id}'`,
        );
      }
      modelIds.add(m.id);
    }
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

// Issue #221/#322: a custom provider may not take a built-in provider's id.
// `setProvider` would silently replace the built-in (its baseUrl and auth),
// so the collision is refused by name instead — trusted file or not.
export function refuseBuiltinCollisions(
  specs: readonly CustomProviderSpec[],
  builtinIds: ReadonlySet<string>,
): void {
  for (const spec of specs) {
    if (builtinIds.has(spec.id)) {
      throw new ModelsJsonError(
        `provider id '${spec.id}' collides with a built-in provider (built-ins are configured by their env key; give the custom provider another id)`,
      );
    }
  }
}

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
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
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
        // Static per-provider headers ride on each model too: pi-ai's stream
        // path merges model.headers into every request (gateway routing
        // headers like opencode-go's x-opencode-session must reach the wire).
        ...(spec.headers === undefined ? {} : { headers: spec.headers }),
        cost: {
          input: m.inputCost ?? 0,
          output: m.outputCost ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        // Fail-safe defaults for an unset window: small local servers
        // overflow (or reject maxTokens) above these. Compaction stays sane
        // through the reserve clamp (compaction.ts effectiveReserveTokens).
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
