// Production wiring of `kubic setup` and the first-run setup of a bare
// `kubic` (issue #451). The command logic is packages/host/src/setup-cli.ts;
// this module supplies the real providers (the same assembly `kubic models`
// reads), the prompt frame, the trust resolver and the config file.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_PROVIDER } from '../../../packages/core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../packages/core/src/cli/logger.js';
import {
  promptConfirm,
  promptFrame,
  promptSelect,
} from '../../../packages/core/src/cli/prompt.js';
import type { CliTheme } from '../../../packages/core/src/cli/theme.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import {
  runSetupCommand,
  SETUP_EXIT_CANCELLED,
  type SetupDeps,
  type SetupProviderChoice,
  type SetupUi,
} from '../../../packages/host/src/setup-cli.js';
import { getSupportedThinkingLevels } from '../../../packages/worker/src/pi-boundary.js';
import {
  type CliConfigResult,
  projectTrustFor,
  resolveInteractiveProjectTrust,
  runtimeModelFrozen,
  runtimeModelPin,
} from './config-runtime.js';

type Env = Readonly<Record<string, string | undefined>>;

export function globalConfigPath(home: string): string {
  return join(home, '.kubic', 'config.toml');
}

// The first-run rule for a bare `kubic` on a terminal: no global config yet,
// no model pinned in the environment, not the testing provider, and not
// explicitly skipped (KUBIC_SKIP_SETUP=1, used by tests and scripts).
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
  const providers: SetupProviderChoice[] = [...assembled.providers]
    .filter(([, info]) => info.usable && info.origin !== 'testing')
    .map(([id, info]) => ({
      id,
      ...(info.authSource === undefined ? {} : { auth: info.authSource }),
      models: assembled.models.getModels(id).map((model) => ({
        id: model.id,
        contextWindow: model.contextWindow,
        thinking: getSupportedThinkingLevels(model),
      })),
    }));
  const pin =
    options.cliConfig === undefined
      ? undefined
      : runtimeModelPin(options.cliConfig);
  const frozen =
    options.cliConfig !== undefined && runtimeModelFrozen(options.cliConfig);
  const configPath = globalConfigPath(home);
  return {
    out: options.out,
    logger: createLineLogger(options.err, { theme: options.errTheme }),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ui: clackUi(),
    providers,
    ...(pin === undefined ? {} : { current: `${pin.provider}/${pin.id}` }),
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
): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (!needsFirstRunSetup(env, home)) return undefined;
  const deps = await prodSetupDeps({ ...options, env, home });
  if (!deps.interactive) return undefined;
  const code = await runSetupCommand({}, deps);
  if (code === EXIT_PROVIDER) return code;
  if (
    code === SETUP_EXIT_CANCELLED &&
    !createNodeFileBridge('/').exists(deps.configPath)
  ) {
    writeConfigFile(deps.configPath, SKIPPED_NOTE);
  }
  return undefined;
}
