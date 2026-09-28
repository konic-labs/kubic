// `kubic models` (issue #20, slice C; §17).
// Catalog readout over an assembled models instance (built-ins plus
// models.json customs registered by the caller). Presentation only.

import { join } from 'node:path';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { parseModelFlag, selectModel } from '../../worker/src/model-select.js';
import {
  parseModelsJson,
  registerCustomProviders,
} from '../../worker/src/models-config.js';
import {
  createModels,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';
import { fauxProviderActive, registerFauxProvider } from './faux-provider.js';

export interface ModelsCommandDeps extends CliIo {
  models: MutableModels;
}

// The parsed `kubic models` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts).
export interface ModelsCommandOptions {
  readonly json?: boolean;
  readonly resolve?: string;
}

// Composition helper: fresh models plus models.json customs when present.
// File access goes through the exec bridge (I/O confinement) — absent or
// invalid models.json is reported, never thrown past the CLI. The faux
// testing provider joins the catalog only under `KUBIC_PROVIDER=faux`.
export function assembleModels(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): {
  models: MutableModels;
  note: string | null;
} {
  const models = createModels({ credentials: new InMemoryCredentialStore() });
  if (fauxProviderActive(env)) registerFauxProvider(models);
  const bridge = createNodeFileBridge('/');
  let raw: string;
  try {
    raw = bridge.readTextFile(join(cwd, 'models.json'));
  } catch {
    return { models, note: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const names = registerCustomProviders(models, parseModelsJson(parsed));
    return { models, note: `loaded models.json: ${names.join(', ')}` };
  } catch (error) {
    return {
      models,
      note: `models.json ignored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  const catalog = deps.models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: deps.models.getModels(provider.id).map((m) => ({
      id: m.id,
      name: m.name,
      thinking: getSupportedThinkingLevels(m),
      inputCost: m.cost.input,
      outputCost: m.cost.output,
    })),
  }));
  if (options.json === true) {
    deps.out(formatJson(catalog));
    return 0;
  }
  if (catalog.length === 0) {
    log.info(
      'no providers registered (add models.json or set provider env keys)',
    );
    return 0;
  }
  const theme = themeOf(deps);
  const rows = catalog.flatMap((provider) =>
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
  return 0;
}
