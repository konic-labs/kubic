// Registering custom providers with the model registry, resolving each
// provider key at request time.

import type { SecretRef } from '@kubic/core/secret-refs';
import type { ApiKeyAuth, MutableModels } from '../pi-boundary.js';
import {
  createProvider,
  envApiKeyAuth,
  openAICompletionsApiLazy,
  openAIResponsesApiLazy,
} from '../pi-boundary.js';
import type { CustomProviderSpec } from './schema.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  ModelsJsonError,
} from './schema.js';

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
