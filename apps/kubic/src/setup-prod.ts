// Production wiring of `kubic setup` and the first-run setup of a bare
// `kubic`. The command logic is packages/host/src/config/setup-cli.ts;
// this module supplies the real providers (the same assembly `kubic models`
// reads), the prompt frame, the trust resolver and the config file.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultModelOf, selectModel } from '@kubic/agent/model-select';
import { getSupportedThinkingLevels } from '@kubic/agent/pi-boundary';
import {
  type CommandResult,
  EXIT_CANCELLED,
  EXIT_PROVIDER,
} from '@kubic/core/cli/exit-codes';
import { createLineLogger } from '@kubic/core/cli/logger';
import {
  promptConfirm,
  promptFrame,
  promptSelect,
} from '@kubic/core/cli/prompt';
import type { CliTheme } from '@kubic/core/cli/theme';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  runSetupCommand,
  type SetupDeps,
  type SetupProviderChoice,
  type SetupUi,
} from '@kubic/host/config';
import { assembleModels } from '@kubic/host/models';
import type { CliConfigResult } from './config/load.js';
import {
  projectTrustFor,
  resolveInteractiveProjectTrust,
} from './config/load.js';
import {
  runtimeModelFrozen,
  runtimeModelPin,
} from './config/model-selection.js';

type Env = Readonly<Record<string, string | undefined>>;

/** @internal */
export function globalConfigPath(home: string): string {
  return join(home, '.kubic', 'config.toml');
}

// The first-run rule for a bare `kubic` on a terminal: no global config yet,
// no model pinned in the environment, not the testing provider, and not
// explicitly skipped (KUBIC_SKIP_SETUP=1, used by tests and scripts).
/** @internal */
export function needsFirstRunSetup(env: Env, home: string): boolean {
  if (env.KUBIC_SKIP_SETUP === '1') return false;
  if ((env.KUBIC_MODEL ?? '') !== '') return false;
  if (env.KUBIC_PROVIDER === 'faux') return false;
  return !createNodeFileBridge('/').exists(globalConfigPath(home));
}

function clackUi(): () => Promise<SetupUi> {
  return async () => {
    const frame = await promptFrame();
    return {
      ...frame,
      select: (message, choices, initial) =>
        promptSelect({
          message,
          choices,
          interactive: true,
          nonInteractive: initial ?? (choices[0]?.value as never),
          ...(initial === undefined ? {} : { initial }),
        }),
      confirm: (message, initial) =>
        promptConfirm({
          message,
          interactive: true,
          nonInteractive: initial,
          initial,
        }),
    };
  };
}

function writeConfigFile(path: string, text: string): void {
  const bridge = createNodeFileBridge('/');
  bridge.createDir(dirname(path), true, 0o700);
  // Write-then-rename: a crash mid-write never leaves a half-written config.
  const temp = `${path}.tmp-${process.pid}`;
  bridge.writeFile(temp, text, { mode: 0o600 });
  bridge.renameFile(temp, path);
}

export interface ProdSetupOptions {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly errTheme: CliTheme;
  /** Absent on the first-run path, which runs before the config load. */
  readonly cliConfig?: CliConfigResult;
  readonly env?: Env;
  readonly cwd?: string;
  readonly home?: string;
}

// The model a run would take with no pin: the first offered provider's
// default model.
function implicitPick(
  models: Parameters<typeof selectModel>[0],
  offered: readonly string[],
): { provider: string; id: string } | undefined {
  try {
    const model = selectModel(models, undefined, undefined, offered);
    return { provider: model.provider, id: model.id };
  } catch {
    return undefined;
  }
}

export async function prodSetupDeps(
  options: ProdSetupOptions,
): Promise<SetupDeps> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.cliConfig?.trust.home ?? options.home ?? homedir();
  const assembled = await assembleModels(cwd, env, {
    home,
    ...(options.cliConfig === undefined
      ? {}
      : { projectTrust: projectTrustFor(options.cliConfig) }),
  });
  // The usable providers in the order the implicit pick tries them, each
  // with its curated default preselected.
  const offered = assembled.fallbackProviders.filter(
    (id) => assembled.providers.get(id)?.origin !== 'testing',
  );
  const providers: SetupProviderChoice[] = offered.map((id) => {
    const info = assembled.providers.get(id);
    const suggested = defaultModelOf(assembled.models, id)?.id;
    return {
      id,
      ...(info?.authSource === undefined ? {} : { auth: info.authSource }),
      models: assembled.models.getModels(id).map((model) => ({
        id: model.id,
        contextWindow: model.contextWindow,
        thinking: getSupportedThinkingLevels(model),
      })),
      ...(suggested === undefined ? {} : { suggested }),
    };
  });
  const pin =
    options.cliConfig === undefined
      ? undefined
      : runtimeModelPin(options.cliConfig);
  // With no pin, setup preselects the model a run would take now.
  const current = pin ?? implicitPick(assembled.models, offered);
  const frozen =
    options.cliConfig !== undefined && runtimeModelFrozen(options.cliConfig);
  const configPath = globalConfigPath(home);
  return {
    out: options.out,
    logger: createLineLogger(options.err, { theme: options.errTheme }),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ui: clackUi(),
    providers,
    ...(current === undefined
      ? {}
      : { current: `${current.provider}/${current.id}` }),
    ...(frozen && pin !== undefined
      ? { enterpriseModel: `${pin.provider}/${pin.id}` }
      : {}),
    trust: (confirm) =>
      resolveInteractiveProjectTrust({ confirm, home, cwd, env }),
    configPath,
    readConfig: () => {
      const bridge = createNodeFileBridge('/');
      return bridge.exists(configPath)
        ? bridge.readTextFile(configPath)
        : undefined;
    },
    writeConfig: (text) => writeConfigFile(configPath, text),
  };
}

const SKIPPED_NOTE =
  '# kubic setup was skipped on first run; run `kubic setup` to choose a default model.\n';

/**
 * The first-run setup of a bare `kubic` on a terminal. Returns an exit code
 * to stop with (no provider has a key), or undefined to open the TUI —
 * after a saved setup, or after a cancelled one (which leaves a comment-only
 * config so the question is not asked on every launch).
 */
export async function prodFirstRunSetup(
  options: ProdSetupOptions,
): Promise<CommandResult | undefined> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (!needsFirstRunSetup(env, home)) return undefined;
  const deps = await prodSetupDeps({ ...options, env, home });
  if (!deps.interactive) return undefined;
  const result = await runSetupCommand({}, deps);
  if (result.exitCode === EXIT_PROVIDER) return result;
  if (
    result.exitCode === EXIT_CANCELLED &&
    !createNodeFileBridge('/').exists(deps.configPath)
  ) {
    writeConfigFile(deps.configPath, SKIPPED_NOTE);
  }
  return undefined;
}
