// models.json custom/local providers.
// Kubic parses + validates models.json; Pi's createProvider builds the
// provider (streaming, auth, cost stay in Pi's model layer — the registry
// is generated, never hand-edited). Only OpenAI-compatible APIs are
// supported for custom endpoints (Ollama-style local path); anything else
// is refused with a named reason, never silently mapped.

import {
  parseSecretRef,
  type SecretRef,
  SecretRefError,
} from '@kubic/core/secret-refs';
import {
  type ApiKeyAuth,
  createProvider,
  envApiKeyAuth,
  type ModelThinkingLevel,
  type MutableModels,
  openAICompletionsApiLazy,
  openAIResponsesApiLazy,
} from './pi-boundary.js';

const CUSTOM_APIS = ['openai-completions', 'openai-responses'] as const;
type CustomApi = (typeof CUSTOM_APIS)[number];

interface CustomModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  /** Input modalities; default text only. */
  input?: ('text' | 'image')[];
  reasoning?: boolean;
  /** Request-body sampling defaults Pi applies to every request. */
  samplingParams?: SamplingParams;
  /**
   * Sampling overrides per thinking level (pi-ai 1.0.2), merged
   * over `samplingParams` for the effective level at request time.
   */
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
}

// Pi's `SamplingParams` / `SamplingParamsByThinkingLevel`, mirrored here
// because pi-boundary.ts (the only file allowed to import @earendil-works/*)
// does not re-export them yet. They move there — and this copy goes — when
// it does; the shapes are pi-ai's verbatim.
/** Merged into the provider request body verbatim (provider-specific keys). */
type SamplingParams = Record<string, unknown>;
type SamplingParamsByThinkingLevel = Partial<
  Record<ModelThinkingLevel, SamplingParams>
>;

export interface CustomProviderSpec {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  /**
   * The key: a literal (`"not-needed"`), an allowlisted `$VAR`, or a
   * `!command` — parsed at load, resolved per request.
   * Escaped `\$` / `\!` stay literal.
   */
  apiKey?: string;
  /**
   * Per-provider headers. Literal values ride statically; `$VAR` (allowlisted)
   * and `!command` values are parsed into `headerRefs` and resolve per request
   * instead.
   */
  headers?: Record<string, string>;
  /** Parsed `apiKey` ref; absent for apiKeyEnv providers. */
  apiKeyRef?: SecretRef;
  /** Parsed header refs by name; literals stay in `headers`. */
  headerRefs?: Record<string, SecretRef>;
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

// The variables a models.json may name as its key. The file
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
// servers overflow above them). A model that relies on this default is
// flagged by `kubic models` and `kubic doctor`.
export const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 2048;

const MODALITIES = ['text', 'image'] as const;
type Modality = (typeof MODALITIES)[number];

// Costs (USD per 1M tokens): the flat `inputCost`/`outputCost` keys or the
// `cost` object `{input, output, cacheRead, cacheWrite}` — one place
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

// Per-thinking-level sampling overrides (pi-ai 1.0.2): a plain
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
  // The output budget must leave room for input inside the window —
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
  // The key: a literal (`"not-needed"`), an allowlisted
  // `$VAR`, or a `!command` — parsed at load through the shared table,
  // resolved per request. Escaped `\$` / `\!` stay literal and never
  // reach the resolver.
  const apiKey = raw.apiKey;
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new ModelsJsonError(
        `provider '${id}': apiKey must be a non-empty string when set`,
      );
    }
    if (apiKeyEnv !== undefined) {
      throw new ModelsJsonError(
        `provider '${id}': set apiKey or apiKeyEnv, not both`,
      );
    }
  }
  let apiKeyRef: SecretRef | undefined;
  if (typeof apiKey === 'string') {
    try {
      apiKeyRef = parseSecretRef(apiKey);
    } catch (error) {
      throw new ModelsJsonError(
        `provider '${id}': apiKey ${error instanceof SecretRefError ? error.message : 'is not a valid secret ref'}`,
      );
    }
    if (apiKeyRef.kind === 'env' && !API_KEY_ENV.test(apiKeyRef.name)) {
      throw new ModelsJsonError(
        `provider '${id}': apiKey '$${apiKeyRef.name}' names '${apiKeyRef.name}' which is not an allowed key variable (use a KUBIC_* name or a *_API_KEY name)`,
      );
    }
  }
  // Per-provider headers (gateways like opencode-go require one on every
  // request). Keys and values must both be non-empty strings — a malformed
  // map is a named refusal, never a silent drop. Literal values ride
  // statically; `$VAR` (allowlisted) and `!command` values are parsed into
  // headerRefs and resolve per request — never verbatim.
  let headers: Record<string, string> | undefined;
  let headerRefs: Record<string, SecretRef> | undefined;
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
      let ref: SecretRef;
      try {
        ref = parseSecretRef(value);
      } catch (error) {
        throw new ModelsJsonError(
          `provider '${id}': headers '${key}' ${error instanceof SecretRefError ? error.message : 'is not a valid secret ref'}`,
        );
      }
      if (ref.kind === 'literal') {
        headers = { ...headers, [key]: ref.value };
        continue;
      }
      if (ref.kind === 'env' && !API_KEY_ENV.test(ref.name)) {
        throw new ModelsJsonError(
          `provider '${id}': headers '${key}' '$${ref.name}' names '${ref.name}' which is not an allowed key variable (use a KUBIC_* name or a *_API_KEY name)`,
        );
      }
      headerRefs = { ...headerRefs, [key]: ref };
    }
  }
  return {
    id,
    ...(typeof raw.name === 'string' && raw.name !== ''
      ? { name: raw.name }
      : {}),
    baseUrl,
    ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}),
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
    ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    ...(headers === undefined ? {} : { headers }),
    ...(headerRefs === undefined ? {} : { headerRefs }),
    api,
    models: raw.models.map((m) => parseModel(m, id)),
  };
}

// `providers` is the object keyed by provider id, or (alias) an array
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

// One request-time use of a models.json provider key:
// the host's resolver reads the named env var through `readEnv` (Pi's auth
// context) and returns the key, auditing the use. It never sees a stored
// credential — those resolve through Pi as before.
// Request-time key material for one custom provider: either
// the legacy named env var or a parsed secret ref. The host's resolver
// reads the named env var through `readEnv` (Pi's auth context) and
// returns the key, auditing the use; a ref use runs the host's secret
// command runner instead. Neither ever sees a stored credential — those
// resolve through Pi as before.
type ApiKeyUse =
  | {
      provider: string;
      envVar: string;
      readEnv: (name: string) => Promise<string | undefined>;
    }
  | {
      provider: string;
      ref: SecretRef;
      readEnv: (name: string) => Promise<string | undefined>;
    };

export interface RegisterCustomProvidersOptions {
  resolveApiKey?: (use: ApiKeyUse) => Promise<string | undefined>;
}

// A custom provider may not take a built-in provider's id.
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

// A models.json literal key: always configured, same shape as Pi's
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

// One provider's key material at registration: a literal
// value, a legacy env-var name, or a parsed secret ref. A literal never
// reaches the host resolver — it is already in the catalog.
type KeyPart =
  | { kind: 'literal'; value: string }
  | { kind: 'envName'; envVar: string }
  | { kind: 'ref'; ref: SecretRef };

function keySourceLabel(key: KeyPart): string {
  if (key.kind === 'literal') return 'models.json apiKey';
  if (key.kind === 'envName') return key.envVar;
  if (key.ref.kind === 'literal') return 'models.json apiKey';
  if (key.ref.kind === 'env') return key.ref.name;
  return `!${key.ref.argv[0] ?? 'command'}`;
}

function noRunnerError(provider: string, what: string): Error {
  return new ModelsJsonError(
    `provider '${provider}': ${what} needs a secret-command runner — the availability probe never executes commands, refusing rather than dropping it`,
  );
}

// Availability WITHOUT resolving (a probe is not a use): a literal is
// always present, an env name reads presence, a command ref is unknowable
// without executing — and the check path never executes.
async function keyAvailable(
  key: KeyPart,
  env: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (key.kind === 'literal') return true;
  if (key.kind === 'envName') return Boolean(await env(key.envVar));
  if (key.ref.kind === 'env') return Boolean(await env(key.ref.name));
  // A command ref (or a hand-built literal): unknowable here at best —
  // the check path never executes, so absence is never reported.
  return true;
}

async function headersAvailable(
  refs: Record<string, SecretRef> | undefined,
  env: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (refs === undefined) return true;
  for (const ref of Object.values(refs)) {
    if (ref.kind === 'env' && !(await env(ref.name))) return false;
  }
  return true;
}

// The no-hook resolver: env refs read env-direct through
// Pi's auth context, literals serve direct, and a `!command` refuses by
// name — the resolve path has no runner of its own, so executing one here
// would silently drop the audit record and the approvals the host runner owns.
async function directSecretResolve(
  use: ApiKeyUse,
): Promise<string | undefined> {
  if ('envVar' in use) return use.readEnv(use.envVar);
  if (use.ref.kind === 'env') return use.readEnv(use.ref.name);
  if (use.ref.kind === 'literal') return use.ref.value;
  throw noRunnerError(use.provider, `apiKey '${use.ref.raw}'`);
}

// The provider's api-key auth when the host resolves keys itself: `check`
// answers availability WITHOUT resolving (a probe is not a use), and every
// `resolve` — Pi calls it per request — goes through the host's resolver.
function providerKeyAuth(
  provider: string,
  key: KeyPart,
  headerRefs: Record<string, SecretRef> | undefined,
  resolveApiKey: (use: ApiKeyUse) => Promise<string | undefined>,
): ApiKeyAuth {
  const label = keySourceLabel(key);
  const base = envApiKeyAuth(`${provider} API key`, [label]);
  return {
    ...base,
    check: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key)
        return { source: 'stored credential', type: 'api_key' };
      const env = (name: string): Promise<string | undefined> => ctx.env(name);
      if (key.kind === 'literal') return { source: label, type: 'api_key' };
      if (key.kind === 'envName') {
        return (await env(key.envVar))
          ? { source: label, type: 'api_key' }
          : undefined;
      }
      if (key.ref.kind === 'env' && !(await env(key.ref.name)))
        return undefined;
      // A command ref is unknowable without executing — and the check path
      // never executes — so it counts as configured here.
      if (!(await headersAvailable(headerRefs, env))) return undefined;
      return { source: label, type: 'api_key' };
    },
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) return base.resolve({ ctx, credential, signal });
      const env = (name: string): Promise<string | undefined> => ctx.env(name);
      if (!(await keyAvailable(key, env))) return undefined;
      if (!(await headersAvailable(headerRefs, env))) {
        const names = Object.keys(headerRefs ?? {});
        throw new ModelsJsonError(
          `provider '${provider}': headers:${names.join(',')} unavailable without their values — refusing rather than sending an incomplete credential set`,
        );
      }
      let keyValue: string | undefined;
      if (key.kind === 'literal') {
        keyValue = key.value;
      } else if (key.kind === 'envName') {
        const value = await env(key.envVar);
        if (value) {
          keyValue = await resolveApiKey({
            provider,
            envVar: key.envVar,
            readEnv: (name) => ctx.env(name),
          });
        }
      } else if (key.ref.kind === 'literal') {
        keyValue = key.ref.value;
      } else {
        keyValue = await resolveApiKey({
          provider,
          ref: key.ref,
          readEnv: (name) => ctx.env(name),
        });
      }
      signal.throwIfAborted();
      if (keyValue === undefined || keyValue === '') return undefined;
      const headers: Record<string, string> = {};
      for (const [name, ref] of Object.entries(headerRefs ?? {})) {
        if (ref.kind === 'literal') {
          headers[name] = ref.value;
        } else {
          const value = await resolveApiKey({
            provider,
            ref,
            readEnv: (n) => ctx.env(n),
          });
          signal.throwIfAborted();
          if (value === undefined || value === '') {
            throw new ModelsJsonError(
              `provider '${provider}': headers '${name}' unavailable without its value — refusing rather than sending it verbatim`,
            );
          }
          headers[name] = value;
        }
      }
      return {
        auth: {
          apiKey: keyValue,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        },
        source: label,
      };
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
    // Api-key precedence: a literal models.json key with no
    // header refs wins outright; otherwise the provider goes through the
    // request-time auth — the host's resolver when given, env-direct with
    // named command refusals when not — and a legacy apiKeyEnv pair keeps
    // Pi's own env auth unless the host takes over.
    let apiKey: ApiKeyAuth;
    if (spec.apiKeyRef?.kind === 'literal' && spec.headerRefs === undefined) {
      apiKey = literalApiKeyAuth(`${spec.id} API key`, spec.apiKeyRef.value);
    } else if (
      spec.apiKeyRef !== undefined ||
      spec.headerRefs !== undefined ||
      options.resolveApiKey !== undefined
    ) {
      const part: KeyPart =
        spec.apiKeyRef === undefined
          ? { kind: 'envName', envVar: key }
          : spec.apiKeyRef.kind === 'literal'
            ? { kind: 'literal', value: spec.apiKeyRef.value }
            : { kind: 'ref', ref: spec.apiKeyRef };
      apiKey = providerKeyAuth(
        spec.id,
        part,
        spec.headerRefs,
        options.resolveApiKey ?? directSecretResolve,
      );
    } else {
      apiKey = envApiKeyAuth(`${spec.id} API key`, [key]);
    }
    const provider = createProvider({
      id: spec.id,
      ...(spec.name === undefined ? {} : { name: spec.name }),
      baseUrl: spec.baseUrl,
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      auth: { apiKey },
      models: spec.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: spec.api,
        provider: spec.id,
        baseUrl: spec.baseUrl,
        reasoning: m.reasoning ?? false,
        input: m.input ?? (['text'] as ('text' | 'image')[]),
        // The model-level sampling defaults and their
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
        // Cache reads and writes are priced separately.
        cost: {
          input: m.inputCost ?? 0,
          output: m.outputCost ?? 0,
          cacheRead: m.cacheReadCost ?? 0,
          cacheWrite: m.cacheWriteCost ?? 0,
        },
        // Fail-safe defaults for an unset window: small local servers
        // overflow (or reject maxTokens) above these. Compaction stays sane
        // through the reserve and kept-window clamps (compaction.ts
        // effectiveReserveTokens and effectiveKeepRecentTokens).
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
