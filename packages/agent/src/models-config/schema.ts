// The models.json vocabulary: custom provider and model shapes, the APIs a
// custom provider may speak, thinking levels and the defaults a model gets.

import type { SecretRef } from '@kubic/core/secret-refs';
import type { ModelThinkingLevel } from '../pi-boundary.js';

const CUSTOM_APIS = ['openai-completions', 'openai-responses'] as const;
type CustomApi = (typeof CUSTOM_APIS)[number];

export interface CustomModelSpec {
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
export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<
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
  /**
   * Mutual TLS for a gateway: the client certificate and key the provider's
   * requests present, and the CA its server certificate chains to when the
   * default roots do not cover it (absolute PEM paths).
   */
  tls?: { cert: string; key: string; ca?: string };
  api: CustomApi;
  models: CustomModelSpec[];
}

export class ModelsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelsJsonError';
  }
}

export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

// The variables a models.json may name as its key. The file
// decides which env value is sent as a bearer token, so it may only name a
// KUBIC_-namespaced variable or an `*_API_KEY` one — never an arbitrary
// secret such as AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN.
export const API_KEY_ENV = /^(KUBIC_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY)$/;

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

// Fail-safe defaults for a model that declares no window (small local
// servers overflow above them). A model that relies on this default is
// flagged by `kubic models` and `kubic doctor`.
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_MAX_TOKENS = 2048;

export const MODALITIES = ['text', 'image'] as const;
export type Modality = (typeof MODALITIES)[number];
