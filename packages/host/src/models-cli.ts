// `kubic models` (issue #20, slice C; §17).
// Catalog readout over an assembled models instance (built-ins plus
// models.json customs registered by the caller). Presentation only.

import { join } from 'node:path';
import { answerHelp } from '../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../core/src/flags.js';
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

export interface ModelsCommandDeps {
  models: MutableModels;
  out: (line: string) => void;
}

// Composition helper: fresh models plus models.json customs when present.
// File access goes through the exec bridge (I/O confinement) — absent or
// invalid models.json is reported, never thrown past the CLI.
export const MODELS_USAGE =
  'usage: kubic models [--json] [--resolve <provider/id>]';

// Issue #127: the shared parser replaces the indexOf/includes pair.
const MODELS_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--json', takes: 'boolean' },
  { name: '--resolve', takes: 'value' },
];

export function assembleModels(cwd: string): {
  models: MutableModels;
  note: string | null;
} {
  const models = createModels({ credentials: new InMemoryCredentialStore() });
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
  args: string[],
  deps: ModelsCommandDeps,
): Promise<number> {
  // `--help`/`-h` is answered before argv parsing (issue #100).
  const help = answerHelp(args, deps.out, MODELS_USAGE);
  if (help !== null) return help;
  const parsed = parseFlagArgs(args, MODELS_FLAG_SPEC);
  const json = parsed.values['--json'] === true;
  const resolveRaw = parsed.values['--resolve'] as string | undefined;
  if (parsed.missing.includes('--resolve')) {
    deps.out('error: --resolve needs provider/id');
    return 1;
  }
  if (resolveRaw !== undefined) {
    try {
      const picked = selectModel(deps.models, parseModelFlag(resolveRaw));
      const levels = getSupportedThinkingLevels(picked);
      deps.out(
        `selected ${picked.provider}/${picked.id} (thinking: ${levels.join(', ') || 'off only'})`,
      );
      return 0;
    } catch (error) {
      deps.out(
        `error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  // Fail-closed on unknown flags (issue #100): they used to be silently
  // ignored, so a typo'd flag looked like a plain catalog readout. Stray
  // operands report through the same line (the pre-migration shape).
  const stray = parsed.unknown[0] ?? parsed.positional[0];
  if (stray !== undefined) {
    deps.out(`error: unknown flag ${stray}`);
    deps.out(MODELS_USAGE);
    return 1;
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
  if (json) {
    deps.out(JSON.stringify(catalog, null, 2));
    return 0;
  }
  if (catalog.length === 0) {
    deps.out(
      'no providers registered (add models.json or set provider env keys)',
    );
    return 0;
  }
  for (const provider of catalog) {
    deps.out(`provider ${provider.id} (${provider.name})`);
    for (const m of provider.models) {
      deps.out(
        `  ${m.id} — thinking: ${m.thinking.join(', ') || 'off only'} — $${m.inputCost}/$${m.outputCost} per 1M in/out`,
      );
    }
  }
  return 0;
}
