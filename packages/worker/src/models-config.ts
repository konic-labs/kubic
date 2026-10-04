// models.json custom/local providers (issue #20, slice A; §37, §38.5).
// Kubic parses + validates models.json; Pi's createProvider builds the
// provider (streaming, auth, cost stay in Pi's model layer — the registry
// is generated, never hand-edited). Only OpenAI-compatible APIs are
// supported for custom endpoints (Ollama-style local path); anything else
// is refused with a named reason, never silently mapped.

import {
  type ApiKeyAuth,
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
  cacheReadCost?: number;
  cacheWriteCost?: number;
  /** Input modalities (§37.2); default text only. */
  input?: ('text' | 'image')[];
  reasoning?: boolean;
  /** Request-body sampling defaults Pi applies to every request. */
  samplingParams?: SamplingParams;
  /**
   * Sampling overrides per thinking level (pi-ai 1.0.2; issue #402), merged
   * over `samplingParams` for the effective level at request time.
   */
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
}

// Pi's `SamplingParams` / `SamplingParamsByThinkingLevel`, mirrored here
// because pi-boundary.ts (the only file allowed to import @earendil-works/*)
// does not re-export them yet. They move there — and this copy goes — when
// it does; the shapes are pi-ai's verbatim.
/** Merged into the provider request body verbatim (provider-specific keys). */
export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<
  Record<ModelThinkingLevel, SamplingParams>
>;

export interface CustomProviderSpec {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  /** A literal key (§38.5 `"apiKey": "not-needed"`); secret refs are refused. */
  apiKey?: string;
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

// Issue #322: the variables a models.json may name as its key. The file
// decides which env value is sent as a bearer token, so it may only name a
// KUBIC_-namespaced variable or an `*_API_KEY` one — never an arbitrary
// secret such as AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN.
const API_KEY_ENV = /^(KUBIC_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY)$/;

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

function optPositiveInt(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ModelsJsonError(
      `${what}: '${key}' must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// Fail-safe defaults for a model that declares no window (small local
// servers overflow above them).
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_MAX_TOKENS = 2048;

const MODALITIES = ['text', 'image'] as const;
type Modality = (typeof MODALITIES)[number];

// Costs (USD per 1M tokens): the flat `inputCost`/`outputCost` keys or the
// §37.2 `cost` object `{input, output, cacheRead, cacheWrite}` — one place
// per field, never both.
function parseCosts(
  raw: Record<string, unknown>,
  what: string,
): Pick<
  CustomModelSpec,
  'inputCost' | 'outputCost' | 'cacheReadCost' | 'cacheWriteCost'
> {
  const flatInput = optNumber(raw, 'inputCost', what);
  const flatOutput = optNumber(raw, 'outputCost', what);
  let cost: Record<string, unknown> = {};
  if (raw.cost !== undefined) {
    if (!isRecord(raw.cost)) {
      throw new ModelsJsonError(
        `${what}: 'cost' must be an object {input, output, cacheRead, cacheWrite}`,
      );
    }
    cost = raw.cost;
    for (const key of Object.keys(cost)) {
      if (!['input', 'output', 'cacheRead', 'cacheWrite'].includes(key)) {
        throw new ModelsJsonError(`${what}: unknown cost field 'cost.${key}'`);
      }
    }
  }
  const input = optNumber(cost, 'input', `${what} cost`);
  const output = optNumber(cost, 'output', `${what} cost`);
  if (flatInput !== undefined && input !== undefined) {
    throw new ModelsJsonError(
      `${what}: set 'inputCost' or 'cost.input', not both`,
    );
  }
  if (flatOutput !== undefined && output !== undefined) {
    throw new ModelsJsonError(
      `${what}: set 'outputCost' or 'cost.output', not both`,
    );
  }
  const inputCost = flatInput ?? input;
  const outputCost = flatOutput ?? output;
  const cacheReadCost = optNumber(cost, 'cacheRead', `${what} cost`);
  const cacheWriteCost = optNumber(cost, 'cacheWrite', `${what} cost`);
  return {
    ...(inputCost === undefined ? {} : { inputCost }),
    ...(outputCost === undefined ? {} : { outputCost }),
    ...(cacheReadCost === undefined ? {} : { cacheReadCost }),
    ...(cacheWriteCost === undefined ? {} : { cacheWriteCost }),
  };
}

function parseInput(
  raw: Record<string, unknown>,
  what: string,
): Modality[] | undefined {
  const value = raw.input;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((m) => (MODALITIES as readonly unknown[]).includes(m)) ||
    new Set(value).size !== value.length
  ) {
    throw new ModelsJsonError(
      `${what}: 'input' must be a non-empty list of distinct modalities from ${JSON.stringify(MODALITIES)} (got ${JSON.stringify(value)})`,
    );
  }
  return value as Modality[];
}

// Per-thinking-level sampling overrides (issue #402; pi-ai 1.0.2): a plain
// object for `samplingParams`, an object keyed by thinking level for
// `samplingParamsByThinkingLevel`. Values are provider request fields Pi
// assigns into the body verbatim (nested values are legitimate), so only the
// shape is validated — an unknown level or a non-object body is refused by
// name, never silently dropped.
function parseSamplingParams(
  raw: Record<string, unknown>,
  key: 'samplingParams' | 'samplingParamsByThinkingLevel',
  what: string,
): SamplingParams | SamplingParamsByThinkingLevel | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ModelsJsonError(
      `${what}: '${key}' must be an object of sampling parameters (got ${JSON.stringify(value)})`,
    );
  }
  if (key === 'samplingParams') return { ...value };
  const byLevel: SamplingParamsByThinkingLevel = {};
  for (const [level, params] of Object.entries(value)) {
    if (!isThinkingLevel(level)) {
      throw new ModelsJsonError(
        `${what}: 'samplingParamsByThinkingLevel' names unknown thinking level '${level}' (levels: ${THINKING_LEVELS.join(', ')})`,
      );
    }
    if (!isRecord(params)) {
      throw new ModelsJsonError(
        `${what}: 'samplingParamsByThinkingLevel.${level}' must be an object of sampling parameters (got ${JSON.stringify(params)})`,
      );
    }
    byLevel[level] = { ...params };
  }
  return byLevel;
}

function parseModel(raw: unknown, providerId: string): CustomModelSpec {
  if (!isRecord(raw))
    throw new ModelsJsonError(
      `provider '${providerId}': model must be an object`,
    );
  const id = reqString(raw, 'id', `provider '${providerId}' model`);
  const what = `model '${id}'`;
  const contextWindow = optPositiveInt(raw, 'contextWindow', what);
  const maxTokens = optPositiveInt(raw, 'maxTokens', what);
  // §27.1: the output budget must leave room for input inside the window —
  // judged on the effective values, so a small declared window with the
  // default maxTokens is refused too (never max_tokens >= the window).
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const output = maxTokens ?? DEFAULT_MAX_TOKENS;
  if (output >= window) {
    throw new ModelsJsonError(
      `${what}: 'maxTokens' (${maxTokens === undefined ? `default ${output}` : output}) must be less than 'contextWindow' (${contextWindow === undefined ? `default ${window}` : window})`,
    );
  }
  const input = parseInput(raw, what);
  const samplingParams = parseSamplingParams(raw, 'samplingParams', what);
  const samplingParamsByThinkingLevel = parseSamplingParams(
    raw,
    'samplingParamsByThinkingLevel',
    what,
  );
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== ''
      ? { name: raw.name }
      : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...parseCosts(raw, what),
    ...(input === undefined ? {} : { input }),
    ...(raw.reasoning === true ? { reasoning: true as const } : {}),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(samplingParamsByThinkingLevel === undefined
      ? {}
      : { samplingParamsByThinkingLevel }),
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
  if (typeof apiKeyEnv === 'string' && !API_KEY_ENV.test(apiKeyEnv)) {
    throw new ModelsJsonError(
      `provider '${id}': apiKeyEnv '${apiKeyEnv}' is not an allowed key variable (use a KUBIC_* name or a *_API_KEY name)`,
    );
  }
  // A literal key (§38.5: `"apiKey": "not-needed"` for a keyless local
  // server). `$ENV`/`!command` secret refs are not resolved here — refused
  // by name rather than sent verbatim as a key.
  const apiKey = raw.apiKey;
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new ModelsJsonError(
        `provider '${id}': apiKey must be a non-empty string when set`,
      );
    }
    if (apiKey.startsWith('$') || apiKey.startsWith('!')) {
      throw new ModelsJsonError(
        `provider '${id}': apiKey secret references ($ENV / !command) are not supported — use apiKeyEnv to read the key from the environment`,
      );
    }
    if (apiKeyEnv !== undefined) {
      throw new ModelsJsonError(
        `provider '${id}': set apiKey or apiKeyEnv, not both`,
      );
    }
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
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
    ...(headers === undefined ? {} : { headers }),
    api,
    models: raw.models.map((m) => parseModel(m, id)),
  };
}

// `providers` is the §38.5 object keyed by provider id, or (alias) an array
// of entries carrying their own `id`. In the object form an entry's own
// `id`, when present, must equal its key.
function providerEntries(providers: unknown): unknown[] {
  if (Array.isArray(providers)) return providers;
  if (!isRecord(providers)) return [];
  return Object.entries(providers).map(([key, entry]) => {
    if (!isRecord(entry)) {
      throw new ModelsJsonError(`provider '${key}': must be an object`);
    }
    if (entry.id !== undefined && entry.id !== key) {
      throw new ModelsJsonError(
        `provider '${key}': 'id' ${JSON.stringify(entry.id)} disagrees with its key '${key}' (omit it in the object form)`,
      );
    }
    return { ...entry, id: key };
  });
}

export function parseModelsJson(raw: unknown): CustomProviderSpec[] {
  if (!isRecord(raw))
    throw new ModelsJsonError(
      'models.json must be an object with a providers object',
    );
  const entries = providerEntries(raw.providers);
  if (entries.length === 0) {
    throw new ModelsJsonError(
      'models.json providers must be a non-empty object keyed by provider id (or a non-empty array)',
    );
  }
  const seen = new Set<string>();
  const specs = entries.map((p) => parseProvider(p));
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

// An array-form local example (the verbatim §38.5 object form is pinned in
// models-config-schema.test.ts). Local-first,
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

// One request-time use of a models.json provider key (issue #359, §36.1):
// the host's resolver reads the named env var through `readEnv` (Pi's auth
// context) and returns the key, auditing the use. It never sees a stored
// credential — those resolve through Pi as before.
export interface ApiKeyUse {
  provider: string;
  envVar: string;
  readEnv: (name: string) => Promise<string | undefined>;
}

export interface RegisterCustomProvidersOptions {
  resolveApiKey?: (use: ApiKeyUse) => Promise<string | undefined>;
}

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

// A models.json literal key (§38.5): always configured, same shape as Pi's
// env-key auth so the provider's stream receives it as the api key.
function literalApiKeyAuth(
  name: string,
  key: string,
): ReturnType<typeof envApiKeyAuth> {
  return {
    name,
    resolve: async ({ signal }) => {
      signal.throwIfAborted();
      return { auth: { apiKey: key }, source: 'models.json apiKey' };
    },
  };
}

// The provider's api-key auth when the host resolves keys itself: `check`
// answers availability WITHOUT resolving (a probe is not a use), and every
// `resolve` — Pi calls it per request — goes through the host's resolver.
function requestTimeApiKeyAuth(
  provider: string,
  envVar: string,
  resolveApiKey: (use: ApiKeyUse) => Promise<string | undefined>,
): ApiKeyAuth {
  const base = envApiKeyAuth(`${provider} API key`, [envVar]);
  return {
    ...base,
    check: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key)
        return { source: 'stored credential', type: 'api_key' };
      const value = await ctx.env(envVar);
      return value ? { source: envVar, type: 'api_key' } : undefined;
    },
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) return base.resolve({ ctx, credential, signal });
      if (!(await ctx.env(envVar))) return undefined;
      const key = await resolveApiKey({
        provider,
        envVar,
        readEnv: (name) => ctx.env(name),
      });
      signal.throwIfAborted();
      return key ? { auth: { apiKey: key }, source: envVar } : undefined;
    },
  };
}

export function registerCustomProviders(
  models: MutableModels,
  specs: CustomProviderSpec[],
  options: RegisterCustomProvidersOptions = {},
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
        // api-key precedence: a literal models.json key wins, then the
        // host's request-time resolver (audited per use), then the env key.
        apiKey:
          spec.apiKey !== undefined
            ? literalApiKeyAuth(`${spec.id} API key`, spec.apiKey)
            : options.resolveApiKey === undefined
              ? envApiKeyAuth(`${spec.id} API key`, [key])
              : requestTimeApiKeyAuth(spec.id, key, options.resolveApiKey),
      },
      models: spec.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: spec.api,
        provider: spec.id,
        baseUrl: spec.baseUrl,
        reasoning: m.reasoning ?? false,
        input: m.input ?? (['text'] as ('text' | 'image')[]),
        // Issue #402: the model-level sampling defaults and their
        // per-thinking-level overrides reach Pi's request builder, which
        // merges the effective level over the defaults.
        ...(m.samplingParams === undefined
          ? {}
          : { samplingParams: m.samplingParams }),
        ...(m.samplingParamsByThinkingLevel === undefined
          ? {}
          : {
              samplingParamsByThinkingLevel: m.samplingParamsByThinkingLevel,
            }),
        // Static per-provider headers ride on each model too: pi-ai's stream
        // path merges model.headers into every request (gateway routing
        // headers like opencode-go's x-opencode-session must reach the wire).
        ...(spec.headers === undefined ? {} : { headers: spec.headers }),
        // §39: cache reads and writes are priced separately (issue #223).
        cost: {
          input: m.inputCost ?? 0,
          output: m.outputCost ?? 0,
          cacheRead: m.cacheReadCost ?? 0,
          cacheWrite: m.cacheWriteCost ?? 0,
        },
        // Fail-safe defaults for an unset window: small local servers
        // overflow (or reject maxTokens) above these. Compaction stays sane
        // through the reserve clamp (compaction.ts effectiveReserveTokens).
        contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
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
