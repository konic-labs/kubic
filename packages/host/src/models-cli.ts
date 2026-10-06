// `kubic models` (issue #20, slice C; §17).
// Catalog readout over an assembled models instance: Pi's generated
// built-in catalogue (issue #221) plus models.json customs. Presentation
// only — nothing here dials a provider.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { parseModelFlag, selectModel } from '../../worker/src/model-select.js';
import {
  parseModelsJson,
  type RegisterCustomProvidersOptions,
  refuseBuiltinCollisions,
  registerCustomProviders,
} from '../../worker/src/models-config.js';
import {
  type AuthContext,
  builtinProviders,
  createModels,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';
import type { ProviderKeyEnv } from './config/role-credentials.js';
import type { DepProbe, ProviderProbe } from './doctor.js';
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
}

// One models.json location the assembly looked at (issue #322): the
// user-global file is always trusted; the project file only after the
// project-trust decision (§35.1).
export interface ModelsSource {
  readonly path: string;
  readonly scope: 'global' | 'project';
  readonly trusted: boolean;
  readonly status: 'loaded' | 'untrusted' | 'invalid';
  readonly providers: readonly string[];
  readonly error?: string;
}

export interface AssembledModels {
  readonly models: MutableModels;
  // Receipt lines: `loaded models.json: …` / `models.json ignored: …`.
  readonly notes: readonly string[];
  readonly providers: ReadonlyMap<string, ProviderInfo>;
  // Every models.json that exists at a looked-up location, in load order.
  readonly sources: readonly ModelsSource[];
  // The providers the implicit first-available pick may use, preferred
  // first: the testing provider, models.json customs, then built-ins whose
  // auth is configured. A keyless built-in is never on this list.
  readonly fallbackProviders: readonly string[];
  // How each provider's key reaches the process (issue #200, §36.3): what
  // an orchestrator worker's role grant must forward. A provider absent here
  // is unregistered — the child's own provider probe names it.
  readonly keyEnv: ReadonlyMap<string, ProviderKeyEnv>;
}

// Assembly options are also the provider-registration options (issue #359,
// §36.1): a run passes its request-time key resolver here and it reaches
// every registerCustomProviders call, so each models.json key use is
// resolved per request and audited.
export interface AssembleOptions extends RegisterCustomProvidersOptions {
  // The home holding ~/.kubic/models/models.json; also what the auth
  // context expands `~` against (tests pass a temp dir).
  readonly home?: string;
  // Issue #228 review: the per-path trust check for the project layer. The
  // project root is resolved by walking ancestors (findModelsProjectRoot),
  // so the decision is checked for THAT root — a grant for /repo covers
  // /repo/models.json when a run starts in /repo/pkg, and a grant for
  // /repo/pkg never reaches /repo. Absent leaves only the global
  // KUBIC_TRUST_PROJECT opt-in.
  readonly projectTrust?: (path: string) => boolean;
}

// The user-global models.json (§35 global tree: ~/.kubic/models/).
export function globalModelsPath(home: string): string {
  return join(home, '.kubic', 'models', 'models.json');
}

// The project root the project models.json lives at (issue #222): the
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

// The project root the project models.json is resolved at (issue #222): the
// manager's root when `KUBIC_MODELS_ROOT` names it (a worker child), else the
// ancestor walk from `cwd`. One derivation for the assembly AND for any caller
// that must decide project trust for THAT root (the orchestrator's child env
// opt-in): trust is per-root, never a boolean for the launch cwd.
export function modelsProjectRootFor(
  cwd: string,
  env: Env,
  home: string,
): string {
  const pinnedRoot = env.KUBIC_MODELS_ROOT;
  return pinnedRoot !== undefined && pinnedRoot !== ''
    ? resolve(pinnedRoot)
    : findModelsProjectRoot(cwd, home);
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

export interface ModelsCommandDeps extends CliIo {
  models: MutableModels;
  // Origin + auth state per provider (from assembleModels). Without it every
  // registered provider is listed as-is.
  providers?: ReadonlyMap<string, ProviderInfo>;
}

// The parsed `kubic models` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts).
export interface ModelsCommandOptions {
  readonly json?: boolean;
  readonly resolve?: string;
}

// Pi's auth context over an explicit env (never the ambient one in tests):
// built-in auth resolution reads env keys and ambient credential files
// through it, both at the availability check and at request time.
function authContextFor(env: Env, home: string): AuthContext {
  return {
    env: async (name) => {
      const value = env[name];
      return value === undefined || value === '' ? undefined : value;
    },
    fileExists: async (path) =>
      createNodeFileBridge('/').exists(
        path.startsWith('~') ? join(home, path.slice(1)) : path,
      ),
  };
}

// §36.3 (issue #200): built-ins whose credential a worker CANNOT be handed.
// A worker gets its provider key through the KUBIC_ROLE_* grant namespace,
// which only Pi's auth resolution reads; these providers' request paths read
// their configuration straight from `process.env` (AWS SDK credentials and
// region, the Azure base URL, Vertex project/location), and the worker env
// allowlist carries none of it. Forwarding the vars Pi's auth check names
// would pass the manager's preflight and still die in the worker (`Provider
// is not configured`), so the plan refuses by name instead.
//
// `viaKey` names the ONE auth source that IS deliverable for a provider that
// also has a process-level form: Vertex authenticated by `GOOGLE_CLOUD_API_KEY`
// gets its `apiKey` from the grant view and its client needs no project or
// location, so that source forwards like any single-key provider; only the
// application-default-credentials form (project + location + a credentials
// file) is refused.
const PROCESS_LEVEL_AUTH: ReadonlyMap<
  string,
  { reason: string; viaKey?: string }
> = new Map([
  [
    'amazon-bedrock',
    {
      reason:
        'it authenticates from process-level AWS configuration (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK, AWS_REGION) that the worker env allowlist does not carry; pin a provider authenticated by a single API key env var',
    },
  ],
  [
    'azure-openai-responses',
    {
      reason:
        'it needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME from the process environment, which the worker env allowlist does not carry; pin a provider authenticated by a single API key env var',
    },
  ],
  [
    'google-vertex',
    {
      reason:
        'without GOOGLE_CLOUD_API_KEY it needs GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and application default credentials from the process environment, which the worker env allowlist does not carry; set GOOGLE_CLOUD_API_KEY or pin a provider authenticated by a single API key env var',
      viaKey: 'GOOGLE_CLOUD_API_KEY',
    },
  ],
]);

// Built-ins whose auth reads more than one env var, all of which the grant
// CAN carry: Pi resolves them through the same auth context the worker sees,
// so each is forwarded next to the key (the plan refuses naming any that is
// unset).
const COMPANION_AUTH_ENV: ReadonlyMap<string, readonly string[]> = new Map([
  ['cloudflare-workers-ai', ['CLOUDFLARE_ACCOUNT_ID']],
  ['cloudflare-ai-gateway', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID']],
]);

// Anthropic workload identity federation (pi-ai 0.99.2; issue #402). Pi
// resolves it only when no stored credential or key is configured, from three
// required ANTHROPIC_* variables plus two optional ids, all read through the
// auth context. That is exactly the context a worker's role grant feeds (the
// child reads the grant back under the plain names), so the block IS
// deliverable next to a key: the grant namespace carries the ids, and the
// identity token's FILE path with them.
const FEDERATION_AUTH_SOURCE = 'workload identity federation';
const FEDERATION_AUTH_ENV: readonly string[] = [
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
];
const FEDERATION_OPTIONAL_ENV: readonly string[] = [
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Composition helper: Pi's built-in providers, then models.json customs —
// the user-global ~/.kubic/models/models.json (trusted), then the project
// file, which is project-local configuration and loads only after project
// trust (issue #322; §35.1): before trust it is never read, only named.
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
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext: authContextFor(env, home),
  });
  const bridge = createNodeFileBridge('/');
  const providers = new Map<string, ProviderInfo>();
  // Issue #200: the per-provider key env names a worker grant may forward.
  const keyEnv = new Map<string, ProviderKeyEnv>();
  const notes: string[] = [];
  const sources: ModelsSource[] = [];
  const customs: string[] = [];
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
  ): void => {
    if (!bridge.exists(path)) return;
    const label = scope === 'global' ? 'global' : 'project';
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
      // A run passes its request-time key resolver (issue #359) so every
      // provider-key use is resolved and audited per request.
      const names = registerCustomProviders(models, specs, options);
      for (const spec of specs) {
        // §36.3 (issue #200): the names a worker role grant must forward.
        // The declared apiKeyEnv, the documented KUBIC_API_KEY default
        // registerCustomProviders falls back to — and (issue #224) every
        // $VAR a ref key or header names, so the child can re-resolve what
        // the manager never materialises. A literal key is already in the
        // catalog and a !command key runs in the child itself, so neither
        // forwards anything — and neither is an undeliverable refusal.
        const refNames = [
          ...(spec.apiKeyRef?.kind === 'env' ? [spec.apiKeyRef.name] : []),
          ...Object.values(spec.headerRefs ?? {}).flatMap((ref) =>
            ref.kind === 'env' ? [ref.name] : [],
          ),
        ];
        const envVars =
          spec.apiKey === undefined
            ? [spec.apiKeyEnv ?? 'KUBIC_API_KEY', ...refNames]
            : refNames;
        keyEnv.set(spec.id, {
          envVars: [...new Set(envVars)],
          noKeyNeeded: envVars.length === 0,
        });
      }
      for (const name of names) {
        const at = customs.indexOf(name);
        if (at !== -1) customs.splice(at, 1);
        customs.push(name);
        providers.set(name, { origin: path, usable: true });
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
  // A worker child runs in its own worktree, which holds only tracked
  // files: the orchestrator names the manager's root in KUBIC_MODELS_ROOT so
  // the child resolves the same project file (issue #222).
  const projectRoot = modelsProjectRootFor(cwd, env, home);
  load(
    projectModelsPath(projectRoot),
    'project',
    options.projectTrust?.(projectRoot) === true || envTrustsProject(env),
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
    if (check !== undefined) usableBuiltins.push(provider.id);
    // §36.3 (issue #200): a built-in authenticated from an env var forwards
    // exactly that var; one authenticated WITHOUT an env var (an ambient
    // credential file the child can reach through HOME) forwards nothing;
    // an unusable one has no deliverable credential at all.
    const envSource =
      check?.source !== undefined &&
      typeof env[check.source] === 'string' &&
      env[check.source] !== ''
        ? check.source
        : undefined;
    // A provider whose credential is process-level configuration the grant
    // namespace cannot carry is refused by name up front (issue #200); one
    // whose auth reads companion vars beside the key forwards all of them.
    // Workload identity federation is such a multi-var auth: Pi checks it
    // through the same auth context, so every var it needs rides the grant.
    const processLevel = PROCESS_LEVEL_AUTH.get(provider.id);
    const undeliverable =
      processLevel !== undefined &&
      !(processLevel.viaKey !== undefined && envSource === processLevel.viaKey)
        ? processLevel.reason
        : undefined;
    const federation = check?.source === FEDERATION_AUTH_SOURCE;
    const envVars = federation
      ? [
          ...FEDERATION_AUTH_ENV,
          ...FEDERATION_OPTIONAL_ENV.filter((name) => (env[name] ?? '') !== ''),
        ]
      : envSource === undefined
        ? []
        : [envSource, ...(COMPANION_AUTH_ENV.get(provider.id) ?? [])];
    keyEnv.set(
      provider.id,
      undeliverable !== undefined
        ? { envVars: [], noKeyNeeded: false, undeliverable }
        : {
            envVars,
            noKeyNeeded:
              !federation && check !== undefined && envSource === undefined,
          },
    );
    providers.set(provider.id, {
      origin: 'built-in',
      usable: check !== undefined,
      ...(check?.source === undefined ? {} : { authSource: check.source }),
    });
  });
  const fallbackProviders = [
    ...(providers.has(FAUX_PROVIDER_ID) ? [FAUX_PROVIDER_ID] : []),
    ...customs,
    ...usableBuiltins.filter((id) => !customs.includes(id)),
  ];
  return {
    models,
    notes,
    providers,
    sources,
    fallbackProviders,
    keyEnv,
  };
}

// Doctor's models.json line (issue #322): each file found, its scope and
// trust state. An invalid file fails the check by name (a refused config is
// never silently ignored); an untrusted one is reported, not failed.
export function modelsSourcesProbe(assembled: AssembledModels): DepProbe {
  if (assembled.sources.length === 0) {
    return {
      id: 'models-json',
      ok: true,
      detail: 'no models.json (built-in providers only)',
    };
  }
  const parts = assembled.sources.map((source) => {
    const where = `${source.path} (${source.scope})`;
    if (source.status === 'loaded')
      return `${where}: loaded ${source.providers.join(', ')}`;
    if (source.status === 'untrusted')
      return `${where}: ignored, untrusted (KUBIC_TRUST_PROJECT=1 to load)`;
    return `${where}: invalid — ${source.error ?? 'unreadable'}`;
  });
  return {
    id: 'models-json',
    ok: assembled.sources.every((source) => source.status !== 'invalid'),
    detail: parts.join('; '),
  };
}

// Doctor's provider lines (issue #221): only the providers a run could use
// — customs, the testing provider, built-ins with configured auth — each
// naming where it came from. Keyless built-ins are not listed (they are not
// available), so a machine with no key still reports no provider.
export function providerProbesOf(assembled: AssembledModels): ProviderProbe[] {
  return assembled.models
    .getProviders()
    .filter(
      (provider) => assembled.providers.get(provider.id)?.usable !== false,
    )
    .map((provider) => {
      const info = assembled.providers.get(provider.id);
      const count = assembled.models.getModels(provider.id).length;
      const from =
        info === undefined
          ? ''
          : info.origin === 'built-in'
            ? ` — built-in${info.authSource === undefined ? '' : `, auth from ${info.authSource}`}`
            : ` — from ${info.origin}`;
      return {
        id: provider.id,
        reachable: true,
        models: assembled.models
          .getModels(provider.id)
          .map((model) => model.id),
        detail: `listed, not dialled, ${count} model(s) registered${from}`,
      };
    });
}

export async function runModelsCommand(
  options: ModelsCommandOptions,
  deps: ModelsCommandDeps,
): Promise<number> {
  const log = diagnosticsOf(deps);
  if (options.resolve !== undefined) {
    try {
      const picked = selectModel(deps.models, parseModelFlag(options.resolve));
      const levels = getSupportedThinkingLevels(picked);
      deps.out(
        `selected ${picked.provider}/${picked.id} (thinking: ${levels.join(', ') || 'off only'})`,
      );
      return 0;
    } catch (error) {
      log.error(errorText(error));
      return 1;
    }
  }
  const info = deps.providers;
  const catalog = deps.models.getProviders().map((provider) => {
    const known = info?.get(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      ...(known === undefined
        ? {}
        : {
            source: known.origin,
            usable: known.usable,
            ...(known.authSource === undefined
              ? {}
              : { auth: known.authSource }),
          }),
      models: deps.models.getModels(provider.id).map((m) => ({
        id: m.id,
        name: m.name,
        thinking: getSupportedThinkingLevels(m),
        inputCost: m.cost.input,
        outputCost: m.cost.output,
        cacheReadCost: m.cost.cacheRead,
        cacheWriteCost: m.cost.cacheWrite,
        input: m.input,
      })),
    };
  });
  if (options.json === true) {
    deps.out(formatJson(catalog));
    return 0;
  }
  // Text mode lists the usable providers in full; the (large) set of
  // built-ins with no configured auth is summarised on one line.
  const listed = catalog.filter((provider) => provider.usable !== false);
  const unconfigured = catalog
    .filter((provider) => provider.usable === false)
    .map((provider) => provider.id);
  if (listed.length === 0) {
    log.info(
      "no usable providers (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)",
    );
  } else {
    const theme = themeOf(deps);
    const rows = listed.flatMap((provider) =>
      provider.models.map((m) => [
        theme.muted(provider.id),
        theme.bold(m.id),
        m.thinking.join(', ') || 'off only',
        `$${m.inputCost}`,
        `$${m.outputCost}`,
      ]),
    );
    deps.out(
      renderTable(
        rows,
        [
          { header: 'PROVIDER' },
          { header: 'MODEL' },
          { header: 'THINKING' },
          { header: 'IN $/1M', align: 'right' },
          { header: 'OUT $/1M', align: 'right' },
        ],
        { fancy: deps.fancy === true, theme },
      ),
    );
  }
  if (unconfigured.length > 0) {
    log.info(
      `${unconfigured.length} built-in providers not configured (set their env key): ${unconfigured.join(', ')}`,
    );
  }
  return 0;
}
