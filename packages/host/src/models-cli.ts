// `kubic models` (issue #20, slice C; §17).
// Catalog readout over an assembled models instance: Pi's generated
// built-in catalogue (issue #221) plus models.json customs. Presentation
// only — nothing here dials a provider.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { parseModelFlag, selectModel } from '../../worker/src/model-select.js';
import {
  parseModelsJson,
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
import type { ProviderProbe } from './doctor.js';
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

export interface AssembledModels {
  readonly models: MutableModels;
  // Receipt lines: `loaded models.json: …` / `models.json ignored: …`.
  readonly notes: readonly string[];
  readonly providers: ReadonlyMap<string, ProviderInfo>;
  // The providers the implicit first-available pick may use, preferred
  // first: the testing provider, models.json customs, then built-ins whose
  // auth is configured. A keyless built-in is never on this list.
  readonly fallbackProviders: readonly string[];
}

export interface AssembleOptions {
  // The home the auth context expands `~` against (tests pass a temp dir).
  readonly home?: string;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Composition helper: Pi's built-in providers, then models.json customs
// when present. File access goes through the exec bridge (I/O confinement)
// — absent or invalid models.json is reported, never thrown past the CLI.
// A custom provider may not reuse a built-in id (refused by name). The faux
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
  const providers = new Map<string, ProviderInfo>();
  const notes: string[] = [];
  const customs: string[] = [];
  if (fauxProviderActive(env)) {
    registerFauxProvider(models);
    providers.set(FAUX_PROVIDER_ID, { origin: 'testing', usable: true });
  }
  const builtins = builtinProviders();
  for (const provider of builtins) models.setProvider(provider);
  const builtinIds = new Set(builtins.map((provider) => provider.id));
  const path = join(cwd, 'models.json');
  let raw: string | undefined;
  try {
    raw = createNodeFileBridge('/').readTextFile(path);
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    try {
      const specs = parseModelsJson(JSON.parse(raw) as unknown);
      refuseBuiltinCollisions(specs, builtinIds);
      for (const name of registerCustomProviders(models, specs)) {
        customs.push(name);
        providers.set(name, { origin: path, usable: true });
      }
      notes.push(`loaded models.json: ${customs.join(', ')}`);
    } catch (error) {
      notes.push(`models.json ignored: ${errorText(error)}`);
    }
  }
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
  return { models, notes, providers, fallbackProviders };
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
