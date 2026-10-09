// Parsing models.json: every provider and model validated, refused by name
// when malformed.

import type { SecretRef } from '@kubic/core/secret-refs';
import { parseSecretRef, SecretRefError } from '@kubic/core/secret-refs';
import type {
  CustomModelSpec,
  CustomProviderSpec,
  Modality,
  SamplingParams,
  SamplingParamsByThinkingLevel,
} from './schema.js';
import {
  API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  isThinkingLevel,
  MODALITIES,
  ModelsJsonError,
  PROVIDER_ID,
  THINKING_LEVELS,
} from './schema.js';

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
