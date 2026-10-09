// `kubic models` and the model checks `kubic doctor` runs: the catalogue
// readout over an assembled catalogue (catalogue.ts), the models.json
// sources, the context-window room and the provider probes. Nothing here
// dials a provider.

import { parseModelFlag, selectModel } from '@kubic/agent/model-select';
import type { MutableModels } from '@kubic/agent/pi-boundary';
import { getSupportedThinkingLevels } from '@kubic/agent/pi-boundary';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import { suggest } from '@kubic/core/suggest';
import type { CliIo } from '../cli/index.js';
import { diagnosticsOf, themeOf } from '../cli/index.js';
import type {
  ContextRoomProbe,
  DepProbe,
  ProviderProbe,
} from '../doctor/index.js';
import type {
  AssembledModels,
  DefaultedWindow,
  ProviderInfo,
} from './catalogue.js';
import { errorText } from './catalogue.js';
import { renderModelsCatalog } from './models-render.js';

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
// apps/kubic/src/commands/setup.ts).
export interface ModelsCommandOptions {
  readonly json?: boolean;
  readonly resolve?: string;
  // List one provider in full (`kubic models <provider>`).
  readonly provider?: string;
  // Include the providers without a configured key.
  readonly all?: boolean;
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

// Doctor's room check: the models the user can configure, with the window the
// registry gives each (a defaulted window included). A model in models.json is
// measured; so is the default model the configuration pins, when it is in the
// registry. Built-in models are not in scope, whatever their key.
export function contextRoomProbeOf(
  assembled: AssembledModels,
  options: {
    readonly defaultModel?: { readonly provider: string; readonly id: string };
    readonly reserveTokens?: number;
    readonly keepRecentTokens?: number;
  } = {},
): ContextRoomProbe {
  const roomModel = (provider: string, id: string) => {
    const contextWindow = assembled.models
      .getModels(provider)
      .find((model) => model.id === id)?.contextWindow;
    return contextWindow === undefined
      ? undefined
      : { provider, model: id, contextWindow };
  };
  const customModels = assembled.customModels.flatMap((ref) => {
    const measured = roomModel(ref.provider, ref.model);
    return measured === undefined ? [] : [measured];
  });
  const defaultModel =
    options.defaultModel === undefined
      ? undefined
      : roomModel(options.defaultModel.provider, options.defaultModel.id);
  return {
    ...(options.reserveTokens === undefined
      ? {}
      : { reserveTokens: options.reserveTokens }),
    ...(options.keepRecentTokens === undefined
      ? {}
      : { keepRecentTokens: options.keepRecentTokens }),
    customModels,
    ...(defaultModel === undefined ? {} : { defaultModel }),
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
