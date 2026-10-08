// `kubic models`.
// Catalog readout over an assembled models instance: Pi's generated
// built-in catalogue plus models.json customs. Presentation
// only — nothing here dials a provider.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../core/src/cli/exit-codes.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { suggest } from '../../core/src/suggest.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { parseModelFlag, selectModel } from '../../worker/src/model-select.js';
import {
  DEFAULT_CONTEXT_WINDOW,
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
import type { DepProbe, ProviderProbe } from './doctor.js';
import {
  FAUX_PROVIDER_ID,
  fauxProviderActive,
  registerFauxProvider,
} from './faux-provider.js';
import { renderModelsCatalog } from './models-render.js';

type Env = Readonly<Record<string, string | undefined>>;

// Where a registered provider came from and whether its auth is configured.
// `origin` is 'built-in' (Pi's generated catalogue), 'testing' (the faux
// provider) or the models.json path that declared it.
interface ProviderInfo {
  readonly origin: string;
  readonly usable: boolean;
  // The auth source Pi reported for a configured built-in (e.g. the env key).
  readonly authSource?: string;
}

// One models.json location the assembly looked at: the
// user-global file is always trusted; the project file only after the
// project-trust decision.
interface ModelsSource {
  readonly path: string;
  readonly scope: 'global' | 'project';
  readonly trusted: boolean;
  readonly status: 'loaded' | 'untrusted' | 'invalid';
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

export interface AssembledModels {
  readonly models: MutableModels;
  // Receipt lines: `loaded models.json: …` / `models.json ignored: …`.
  readonly notes: readonly string[];
  readonly providers: ReadonlyMap<string, ProviderInfo>;
  // Every models.json that exists at a looked-up location, in load order.
  readonly sources: readonly ModelsSource[];
  // The loaded models whose window is the fallback default.
  readonly defaultedWindows: readonly DefaultedWindow[];
  // The providers the implicit first-available pick may use, preferred
  // first: the testing provider, models.json customs, then built-ins whose
  // auth is configured. A keyless built-in is never on this list.
  readonly fallbackProviders: readonly string[];
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

export interface ModelsCommandDeps extends CliIo {
  models: MutableModels;
  // Origin + auth state per provider (from assembleModels). Without it every
  // registered provider is listed as-is.
  providers?: ReadonlyMap<string, ProviderInfo>;
  // The models running on the fallback window (from assembleModels); each is
  // marked in the catalogue.
  defaultedWindows?: readonly DefaultedWindow[];
  // The configured model pin (`provider/id`), marked as the
  // default in the terminal view. Absent: the selection chain's own pick.
  defaultModel?: string;
}

// The parsed `kubic models` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts).
export interface ModelsCommandOptions {
  readonly json?: boolean;
  readonly resolve?: string;
  // List one provider in full (`kubic models <provider>`).
  readonly provider?: string;
  // Include the providers without a configured key.
  readonly all?: boolean;
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

function errorText(error: unknown): string {
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
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext: authContextFor(env, home),
  });
  const bridge = createNodeFileBridge('/');
  const providers = new Map<string, ProviderInfo>();
  const notes: string[] = [];
  const sources: ModelsSource[] = [];
  const customs: string[] = [];
  const defaultedWindows: DefaultedWindow[] = [];
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
        for (let index = defaultedWindows.length - 1; index >= 0; index--) {
          if (defaultedWindows[index]?.provider === spec.id) {
            defaultedWindows.splice(index, 1);
          }
        }
        for (const model of spec.models) {
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
    defaultedWindows,
    fallbackProviders,
  };
}

// Doctor's models.json line: each file found, its scope and
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

// Doctor's provider lines: only the providers a run could use
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

// The default the terminal view marks: the configured pin, else the model
// the selection chain would pick with no pin (first usable provider).
function defaultOf(deps: ModelsCommandDeps): { defaultModel?: string } {
  if (deps.defaultModel !== undefined)
    return { defaultModel: deps.defaultModel };
  try {
    const picked = selectModel(deps.models, undefined);
    return { defaultModel: `${picked.provider}/${picked.id}` };
  } catch {
    return {};
  }
}

export async function runModelsCommand(
  options: ModelsCommandOptions,
  deps: ModelsCommandDeps,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  if (options.resolve !== undefined) {
    try {
      const picked = selectModel(deps.models, parseModelFlag(options.resolve));
      const levels = getSupportedThinkingLevels(picked);
      deps.out(
        `selected ${picked.provider}/${picked.id} (thinking: ${levels.join(', ') || 'off only'})`,
      );
      return { exitCode: EXIT_OK };
    } catch (error) {
      log.error(errorText(error));
      return { exitCode: EXIT_FAILED };
    }
  }
  const info = deps.providers;
  const defaulted = new Set(
    (deps.defaultedWindows ?? []).map((w) => `${w.provider}/${w.model}`),
  );
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
        contextWindow: m.contextWindow,
        ...(defaulted.has(`${provider.id}/${m.id}`)
          ? { contextWindowDefaulted: true }
          : {}),
        thinking: getSupportedThinkingLevels(m),
        inputCost: m.cost.input,
        outputCost: m.cost.output,
        cacheReadCost: m.cost.cacheRead,
        cacheWriteCost: m.cost.cacheWrite,
        input: m.input,
      })),
    };
  });
  if (
    options.provider !== undefined &&
    !catalog.some((provider) => provider.id === options.provider)
  ) {
    const ids = catalog.map((provider) => provider.id);
    const [close] = suggest(options.provider, ids);
    log.error(
      close === undefined
        ? `unknown provider ${JSON.stringify(options.provider)} (known: ${ids.join(', ')})`
        : `unknown provider ${JSON.stringify(options.provider)}; did you mean '${close}'?`,
    );
    return { exitCode: EXIT_USAGE };
  }
  const scoped =
    options.provider === undefined
      ? catalog
      : catalog.filter((provider) => provider.id === options.provider);
  if (options.json === true) {
    deps.out(formatJson(scoped));
    return { exitCode: EXIT_OK };
  }
  if (deps.fancy === true) {
    // The catalogue view on an interactive colour terminal.
    for (const line of renderModelsCatalog(catalog, themeOf(deps), {
      ...(options.provider === undefined ? {} : { only: options.provider }),
      ...(options.all === true ? { all: true } : {}),
      ...defaultOf(deps),
    })) {
      deps.out(line);
    }
    return { exitCode: EXIT_OK };
  }
  // Text mode lists the usable providers in full; the (large) set of
  // built-ins with no configured auth is summarised on one line. A named
  // provider or `--all` widens the table to exactly what was asked for.
  const listed = scoped.filter(
    (provider) =>
      options.provider !== undefined ||
      options.all === true ||
      provider.usable !== false,
  );
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
        // The terminal view returned above: this is the plain table.
        { theme },
      ),
    );
  }
  if (
    unconfigured.length > 0 &&
    options.provider === undefined &&
    options.all !== true
  ) {
    log.info(
      `${unconfigured.length} built-in providers not configured (set their env key): ${unconfigured.join(', ')}`,
    );
  }
  return { exitCode: EXIT_OK };
}
