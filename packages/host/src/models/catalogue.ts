// The model catalogue a command runs with: Pi's built-in providers, then the
// models.json customs of the user and, once trusted, of the project, and the
// faux testing provider under `KUBIC_PROVIDER=faux`.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  CustomProviderSpec,
  RegisterCustomProvidersOptions,
} from '@kubic/agent/models-config';
import {
  DEFAULT_CONTEXT_WINDOW,
  parseModelsJson,
  refuseBuiltinCollisions,
  registerCustomProviders,
} from '@kubic/agent/models-config';
import type { AuthContext, MutableModels } from '@kubic/agent/pi-boundary';
import {
  builtinProviders,
  createModels,
  InMemoryCredentialStore,
} from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { type Keychain, osKeychain } from '@kubic/exec/keychain';
import { keychainKeys } from '../credentials/index.js';
import { awsRegionOf } from './aws-region.js';
import {
  FAUX_PROVIDER_ID,
  fauxProviderActive,
  registerFauxProvider,
} from './faux-provider.js';

type Env = Readonly<Record<string, string | undefined>>;

// Where a registered provider came from and whether its auth is configured.
// `origin` is 'built-in' (Pi's generated catalogue), 'testing' (the faux
// provider) or the models.json path that declared it.
export interface ProviderInfo {
  readonly origin: string;
  readonly usable: boolean;
  // The auth source Pi reported for a configured built-in (e.g. the env key).
  readonly authSource?: string;
  // Why a built-in with credentials still cannot run (Bedrock without a
  // region); doctor warns with it.
  readonly unusable?: string;
}

// The order the implicit pick tries usable built-ins: the providers a key is
// most likely meant for first, then the rest in catalogue order, and last the
// ambient credentials a machine carries for other reasons (an AWS profile, a
// Google application-default login, an editor's Copilot or Codex session), so
// they never take the default away from an explicit key.
const PREFERRED_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'];
const AMBIENT_PROVIDERS: ReadonlySet<string> = new Set([
  'amazon-bedrock',
  'google-vertex',
  'github-copilot',
  'openai-codex',
]);

function preferenceOrder(ids: readonly string[]): string[] {
  const preferred = PREFERRED_PROVIDERS.filter((id) => ids.includes(id));
  const rest = ids.filter(
    (id) => !PREFERRED_PROVIDERS.includes(id) && !AMBIENT_PROVIDERS.has(id),
  );
  const ambient = ids.filter((id) => AMBIENT_PROVIDERS.has(id));
  return [...preferred, ...rest, ...ambient];
}

// What a built-in with credentials still lacks to reach its endpoint:
// Bedrock without a region ("Region is missing"), Azure OpenAI without its
// resource, Vertex AI's application-default login without a project and a
// location (Pi then reports no credentials at all).
function endpointGap(
  provider: string,
  source: string | undefined,
  env: Env,
  home: string,
): string | undefined {
  if (
    provider === 'amazon-bedrock' &&
    source !== undefined &&
    awsRegionOf(env, home) === undefined
  ) {
    return `credentials from ${source} but no AWS region: set AWS_REGION (or AWS_DEFAULT_REGION, or region in the profile) to use it`;
  }
  if (
    provider === 'azure-openai-responses' &&
    source !== undefined &&
    !env.AZURE_OPENAI_RESOURCE_NAME &&
    !env.AZURE_OPENAI_BASE_URL
  ) {
    return `a key from ${source} but no Azure OpenAI resource: set AZURE_OPENAI_RESOURCE_NAME (or AZURE_OPENAI_BASE_URL), and AZURE_OPENAI_DEPLOYMENT_NAME_MAP when a deployment is not named after its model`;
  }
  if (
    provider === 'google-vertex' &&
    source === undefined &&
    vertexLoginFound(env, home) &&
    (!(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT) ||
      !env.GOOGLE_CLOUD_LOCATION)
  ) {
    return 'an application-default Google login but no project or location: set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION (a Vertex AI region, or global) to use it';
  }
  return undefined;
}

function vertexLoginFound(env: Env, home: string): boolean {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  try {
    return createNodeFileBridge('/').exists(
      join(home, '.config', 'gcloud', 'application_default_credentials.json'),
    );
  } catch {
    return false;
  }
}

// One models.json location the assembly looked at: the
// user-global file is always trusted; the project file only after the
// project-trust decision.
interface ModelsSource {
  readonly path: string;
  readonly scope: 'global' | 'project';
  readonly trusted: boolean;
  readonly status: 'loaded' | 'untrusted' | 'forbidden' | 'invalid';
  readonly providers: readonly string[];
  readonly error?: string;
}

// A models.json model that declares no `contextWindow`: it runs with the
// fallback window, which `kubic models` and `kubic doctor` report.
export interface DefaultedWindow {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}

// A model the user defined in a loaded models.json. Built-in models are never
// listed here: models.json cannot redeclare them.
interface CustomModelRef {
  readonly provider: string;
  readonly model: string;
}

// A models.json provider whose key would travel unencrypted: a plain-http
// base URL to a host other than this machine.
interface PlaintextKey {
  readonly provider: string;
  readonly host: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/u.test(host) ||
    host === '::1'
  );
}

// The host a provider would send its key to in clear text: an `http:` base
// URL off this machine, with a key or a secret header. Local model servers
// (localhost, 127.0.0.0/8, ::1) are not flagged.
function plaintextKeyHost(spec: CustomProviderSpec): string | undefined {
  let url: URL;
  try {
    url = new URL(spec.baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) {
    return undefined;
  }
  const keyed =
    spec.apiKeyEnv !== undefined ||
    spec.apiKey !== undefined ||
    Object.keys(spec.headerRefs ?? {}).length > 0;
  return keyed ? url.host : undefined;
}

// Removes the entries of one provider id, in place: a later file that defines
// the provider replaces what an earlier file recorded for it.
function dropProvider(
  entries: { readonly provider: string }[],
  provider: string,
): void {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.provider === provider) entries.splice(index, 1);
  }
}

export interface AssembledModels {
  readonly models: MutableModels;
  // Receipt lines: `loaded models.json: …` / `models.json ignored: …`.
  readonly notes: readonly string[];
  readonly providers: ReadonlyMap<string, ProviderInfo>;
  // Every models.json that exists at a looked-up location, in load order.
  readonly sources: readonly ModelsSource[];
  // The loaded models whose window is the fallback default.
  readonly defaultedWindows: readonly DefaultedWindow[];
  // The models the loaded models.json files define.
  readonly customModels: readonly CustomModelRef[];
  // The loaded providers that would send their key over plain http.
  readonly plaintextKeys: readonly PlaintextKey[];
  // The providers the implicit pick may use, preferred first: the testing
  // provider, models.json customs, then the built-ins whose auth is
  // configured, in preference order (see PREFERRED_PROVIDERS). A keyless
  // built-in is never on this list.
  readonly fallbackProviders: readonly string[];
  // The keys read from the keychain, for the run's scrub.
  readonly keychainSecrets: readonly string[];
}

// Assembly options are also the provider-registration options: a run passes its
// request-time key resolver here and it reaches every registerCustomProviders
// call, so each models.json key use is resolved per request and audited.
export interface AssembleOptions extends RegisterCustomProvidersOptions {
  // The home holding ~/.kubic/models/models.json; also what the auth
  // context expands `~` against (tests pass a temp dir).
  readonly home?: string;
  // The per-path trust check for the project layer. The
  // project root is resolved by walking ancestors (findModelsProjectRoot),
  // so the decision is checked for THAT root — a grant for /repo covers
  // /repo/models.json when a run starts in /repo/pkg, and a grant for
  // /repo/pkg never reaches /repo. Absent leaves only the global
  // KUBIC_TRUST_PROJECT opt-in.
  readonly projectTrust?: (path: string) => boolean;
  // Why the project models.json stays out even when trusted (an enterprise
  // `[policy] project_policy = "restricted"`). Absent: it loads once trusted.
  readonly projectProvidersRefusal?: string;
  // Where `kubic keys` stored keys are read from (tests); absent: this
  // machine's keychain.
  readonly keychain?: Keychain;
}

// The user-global models.json (global tree: ~/.kubic/models/).
function globalModelsPath(home: string): string {
  return join(home, '.kubic', 'models', 'models.json');
}

// The project root the project models.json lives at: the
// nearest ancestor of `cwd` (itself included) holding a `.git` entry (a
// repository or worktree top level) or a `.kubic` directory — never the home
// directory, whose `.kubic` is the GLOBAL tree. No marker: `cwd` itself.
export function findModelsProjectRoot(cwd: string, home: string): string {
  const bridge = createNodeFileBridge('/');
  const homeDir = resolve(home);
  let dir = resolve(cwd);
  for (;;) {
    if (
      bridge.exists(join(dir, '.git')) ||
      (dir !== homeDir && bridge.exists(join(dir, '.kubic')))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

// The project root the project models.json is resolved at: the ancestor walk
// from `cwd`. One derivation for the assembly AND for any caller that must
// decide project trust for THAT root: trust is per-root, never a boolean for
// the launch cwd.
function modelsProjectRootFor(cwd: string, home: string): string {
  return findModelsProjectRoot(cwd, home);
}

// The project models.json candidates at a root, first present wins.
function projectModelsPath(root: string): string {
  const bridge = createNodeFileBridge('/');
  const dotKubic = join(root, '.kubic', 'models.json');
  return bridge.exists(dotKubic) ? dotKubic : join(root, 'models.json');
}

function envTrustsProject(env: Env): boolean {
  const value = env.KUBIC_TRUST_PROJECT;
  return value === '1' || value === 'true';
}

// Pi's auth context over an explicit env (never the ambient one in tests):
// built-in auth resolution reads env keys and ambient credential files
// through it, both at the availability check and at request time.
// The auth context reads the environment at request time (a refreshed
// token is seen), then the keys `kubic keys` stored.
function authContextFor(
  env: Env,
  home: string,
  stored: Readonly<Record<string, string>>,
): AuthContext {
  return {
    env: async (name) => {
      const value = env[name];
      return value === undefined || value === '' ? stored[name] : value;
    },
    fileExists: async (path) =>
      createNodeFileBridge('/').exists(
        path.startsWith('~') ? join(home, path.slice(1)) : path,
      ),
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Composition helper: Pi's built-in providers, then models.json customs —
// the user-global ~/.kubic/models/models.json (trusted), then the project
// file, which is project-local configuration and loads only after project
// trust: before trust it is never read, only named.
// A project provider overrides a global one with the same id. File access
// goes through the exec bridge (I/O confinement) — absent or invalid
// models.json is reported, never thrown past the CLI. A custom provider may
// not reuse a built-in id (refused by name, trusted or not). The faux
// testing provider joins the catalog only under `KUBIC_PROVIDER=faux`.
export async function assembleModels(
  cwd: string,
  env: Env = process.env,
  options: AssembleOptions = {},
): Promise<AssembledModels> {
  const home = options.home ?? homedir();
  // Keys `kubic keys` stored, for the variables the environment leaves unset.
  const stored = keychainKeys(env, home, options.keychain ?? osKeychain());
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext: authContextFor(env, home, stored),
  });
  const bridge = createNodeFileBridge('/');
  const providers = new Map<string, ProviderInfo>();
  const notes: string[] = [];
  const sources: ModelsSource[] = [];
  const customs: string[] = [];
  const defaultedWindows: DefaultedWindow[] = [];
  const customModels: CustomModelRef[] = [];
  const plaintextKeys: PlaintextKey[] = [];
  if (fauxProviderActive(env)) {
    registerFauxProvider(models);
    providers.set(FAUX_PROVIDER_ID, { origin: 'testing', usable: true });
  }
  const builtins = builtinProviders();
  for (const provider of builtins) models.setProvider(provider);
  const builtinIds = new Set(builtins.map((provider) => provider.id));
  const load = (
    path: string,
    scope: ModelsSource['scope'],
    trusted: boolean,
    refusal?: string,
  ): void => {
    if (!bridge.exists(path)) return;
    const label = scope === 'global' ? 'global' : 'project';
    if (refusal !== undefined) {
      sources.push({
        path,
        scope,
        trusted,
        status: 'forbidden',
        providers: [],
        error: refusal,
      });
      notes.push(`models.json ignored: ${path} (${label}, ${refusal})`);
      return;
    }
    if (!trusted) {
      // Refused before the file is read: nothing in it reaches the catalog.
      sources.push({
        path,
        scope,
        trusted,
        status: 'untrusted',
        providers: [],
      });
      notes.push(
        `models.json ignored: ${path} (${label}, untrusted — run 'kubic trust' or set KUBIC_TRUST_PROJECT=1 to load it)`,
      );
      return;
    }
    try {
      const specs = parseModelsJson(
        JSON.parse(bridge.readTextFile(path)) as unknown,
      );
      refuseBuiltinCollisions(specs, builtinIds);
      // A run passes its request-time key resolver so every
      // provider-key use is resolved and audited per request.
      const names = registerCustomProviders(models, specs, options);
      for (const name of names) {
        const at = customs.indexOf(name);
        if (at !== -1) customs.splice(at, 1);
        customs.push(name);
        providers.set(name, { origin: path, usable: true });
      }
      for (const spec of specs) {
        // A file that defines a provider replaces the earlier files' entries
        // for it, so a fallback an earlier file left cannot survive.
        dropProvider(defaultedWindows, spec.id);
        dropProvider(customModels, spec.id);
        dropProvider(plaintextKeys, spec.id);
        const clear = plaintextKeyHost(spec);
        if (clear !== undefined) {
          plaintextKeys.push({ provider: spec.id, host: clear });
          notes.push(
            `models.json: provider '${spec.id}' sends its API key over plain http to ${clear} — use an https baseUrl`,
          );
        }
        for (const model of spec.models) {
          customModels.push({ provider: spec.id, model: model.id });
          if (model.contextWindow !== undefined) continue;
          defaultedWindows.push({
            provider: spec.id,
            model: model.id,
            contextWindow: DEFAULT_CONTEXT_WINDOW,
          });
        }
      }
      sources.push({
        path,
        scope,
        trusted,
        status: 'loaded',
        providers: names,
      });
      notes.push(
        `loaded models.json: ${path} (${scope === 'global' ? 'global' : 'project, trusted'}): ${names.join(', ')}`,
      );
    } catch (error) {
      sources.push({
        path,
        scope,
        trusted,
        status: 'invalid',
        providers: [],
        error: errorText(error),
      });
      notes.push(`models.json ignored: ${path}: ${errorText(error)}`);
    }
  };
  load(globalModelsPath(home), 'global', true);
  const projectRoot = modelsProjectRootFor(cwd, home);
  load(
    projectModelsPath(projectRoot),
    'project',
    options.projectTrust?.(projectRoot) === true || envTrustsProject(env),
    options.projectProvidersRefusal,
  );
  const checks = await Promise.all(
    builtins.map(async (provider) => {
      try {
        return await models.checkAuth(provider.id);
      } catch {
        return undefined;
      }
    }),
  );
  const usableBuiltins: string[] = [];
  builtins.forEach((provider, index) => {
    const check = checks[index];
    // Credentials that cannot reach an endpoint fail every request: such a
    // provider is not usable, and doctor says what to set.
    const unusable = endpointGap(provider.id, check?.source, env, home);
    const usable = check !== undefined && unusable === undefined;
    if (usable) usableBuiltins.push(provider.id);
    providers.set(provider.id, {
      origin: 'built-in',
      usable,
      ...(check?.source === undefined ? {} : { authSource: check.source }),
      ...(unusable === undefined ? {} : { unusable }),
    });
  });
  const fallbackProviders = [
    ...(providers.has(FAUX_PROVIDER_ID) ? [FAUX_PROVIDER_ID] : []),
    ...customs,
    ...preferenceOrder(usableBuiltins.filter((id) => !customs.includes(id))),
  ];
  return {
    keychainSecrets: Object.values(stored),
    models,
    notes,
    providers,
    sources,
    defaultedWindows,
    customModels,
    plaintextKeys,
    fallbackProviders,
  };
}
