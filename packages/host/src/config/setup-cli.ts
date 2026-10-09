// `kubic setup`: from "installed" to
// "ready" in under a minute — pick a provider whose key is detected, a
// default model and its thinking level, answer the project trust question
// when there is one, and save `[model]` to the global config.toml (every
// other line of that file preserved). Interactive only; a cancelled step
// writes nothing.

import {
  type CommandResult,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  type ExitCode,
} from '@kubic/core/cli/exit-codes';
import type { SelectChoice } from '@kubic/core/cli/prompt';
import { type CliIo, diagnosticsOf } from '../cli/index.js';
import { formatContext } from '../models/index.js';
import { upsertModelTable } from './toml-model.js';

interface SetupModelChoice {
  readonly id: string;
  readonly contextWindow?: number;
  readonly thinking: readonly string[];
}

export interface SetupProviderChoice {
  readonly id: string;
  /** Where its key comes from (`ANTHROPIC_API_KEY`, `AWS_PROFILE`, a path). */
  readonly auth?: string;
  readonly models: readonly SetupModelChoice[];
}

export interface SetupUi {
  intro(title: string): void;
  step(message: string): void;
  select<T extends string>(
    message: string,
    choices: readonly SelectChoice<T>[],
    initial?: T,
  ): Promise<T | null>;
  confirm(message: string, initial: boolean): Promise<boolean | null>;
  outro(message: string): void;
  cancel(message: string): void;
}

export interface SetupDeps extends CliIo {
  /** stdin AND stdout are a TTY. */
  readonly interactive: boolean;
  /** The prompt frame; built lazily so a refusal never loads it. */
  readonly ui: () => Promise<SetupUi>;
  /** Usable providers (a key is configured), testing provider excluded. */
  readonly providers: readonly SetupProviderChoice[];
  /** The model a run would use now (`provider/id`), preselected. */
  readonly current?: string;
  /** A frozen enterprise `[model]` (`provider/id`): no model question. */
  readonly enterpriseModel?: string;
  /**
   * The project trust question when this directory has a project layer
   * and no recorded decision; `undefined` when there is nothing to ask.
   */
  readonly trust?: (
    confirm: (message: string) => Promise<boolean | null>,
  ) => Promise<boolean | undefined>;
  /** The global config.toml to update. */
  readonly configPath: string;
  readonly readConfig: () => string | undefined;
  readonly writeConfig: (text: string) => void;
}

// biome-ignore lint/complexity/noBannedTypes: no options yet; the registrar passes {}
export type SetupCommandOptions = {};

const NO_KEY_LINES = [
  'no model provider has a key — set one, then run kubic setup again:',
  '  export ANTHROPIC_API_KEY=…     anthropic',
  '  export OPENAI_API_KEY=…        openai',
  '  export OPENROUTER_API_KEY=…    many models through one key',
  '  or add a local model in ~/.kubic/models/models.json',
];

function modelHint(model: SetupModelChoice): string {
  const thinks = model.thinking.some((level) => level !== 'off');
  return `${formatContext(model.contextWindow)} ctx · ${thinks ? 'thinking' : 'no thinking'}`;
}

function defaultThinking(levels: readonly string[]): string {
  for (const preferred of ['medium', 'high', 'low']) {
    if (levels.includes(preferred)) return preferred;
  }
  return levels.find((level) => level !== 'off') ?? 'off';
}

export async function runSetupCommand(
  _options: SetupCommandOptions,
  deps: SetupDeps,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  if (!deps.interactive) {
    log.error(
      'kubic setup is interactive: run it in a terminal, or set [model] provider/id in ~/.kubic/config.toml (or KUBIC_MODEL=<provider/id>)',
    );
    return { exitCode: EXIT_USAGE };
  }
  const ui = await deps.ui();
  ui.intro('kubic setup');
  const cancelled = (): ExitCode => {
    ui.cancel('setup cancelled — nothing was written');
    return EXIT_CANCELLED;
  };

  let model: { provider: string; id: string; thinking?: string } | undefined;
  if (deps.enterpriseModel !== undefined) {
    ui.step(`Model  ${deps.enterpriseModel} — pinned by enterprise policy`);
  } else {
    if (deps.providers.length === 0) {
      ui.cancel(NO_KEY_LINES.join('\n'));
      return { exitCode: EXIT_PROVIDER };
    }
    let provider = deps.providers[0] as SetupProviderChoice;
    if (deps.providers.length === 1) {
      ui.step(
        `Provider  ${provider.id}${provider.auth === undefined ? '' : ` — key from ${provider.auth}`}`,
      );
    } else {
      const currentProvider = deps.current?.split('/')[0];
      const picked = await ui.select(
        'Provider',
        deps.providers.map((choice) => ({
          value: choice.id,
          label: choice.id,
          ...(choice.auth === undefined
            ? {}
            : { hint: `key from ${choice.auth}` }),
        })),
        deps.providers.some((choice) => choice.id === currentProvider)
          ? currentProvider
          : undefined,
      );
      if (picked === null) return { exitCode: cancelled() };
      provider =
        deps.providers.find((choice) => choice.id === picked) ?? provider;
    }
    if (provider.models.length === 0) {
      log.error(`provider '${provider.id}' lists no chat models`);
      return { exitCode: EXIT_PROVIDER };
    }
    const currentId = deps.current?.startsWith(`${provider.id}/`)
      ? deps.current.slice(provider.id.length + 1)
      : undefined;
    const id = await ui.select(
      'Default model',
      provider.models.map((choice) => ({
        value: choice.id,
        label: choice.id,
        hint: modelHint(choice),
      })),
      provider.models.some((choice) => choice.id === currentId)
        ? currentId
        : undefined,
    );
    if (id === null) return { exitCode: cancelled() };
    const chosen = provider.models.find((choice) => choice.id === id);
    const levels = chosen?.thinking ?? [];
    let thinking: string | undefined;
    if (levels.some((level) => level !== 'off')) {
      const picked = await ui.select(
        'Thinking level',
        levels.map((level) => ({ value: level, label: level })),
        defaultThinking(levels),
      );
      if (picked === null) return { exitCode: cancelled() };
      thinking = picked;
    }
    model = {
      provider: provider.id,
      id,
      ...(thinking === undefined ? {} : { thinking }),
    };
  }

  if (deps.trust !== undefined) {
    let cancelledTrust = false;
    const decision = await deps.trust(async (message) => {
      const answer = await ui.confirm(message, false);
      if (answer === null) cancelledTrust = true;
      return answer;
    });
    if (cancelledTrust) return { exitCode: cancelled() };
    if (decision !== undefined) {
      ui.step(
        decision
          ? 'Project trusted'
          : 'Project not trusted — kubic trust later',
      );
    }
  }

  if (model === undefined) {
    ui.outro('nothing to save — run kubic to start');
    return { exitCode: EXIT_OK };
  }
  const updated = upsertModelTable(deps.readConfig() ?? '', model);
  try {
    deps.writeConfig(updated);
  } catch (error) {
    log.error(
      `could not write ${deps.configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: EXIT_FAILED };
  }
  ui.outro(`saved to ${deps.configPath} — run kubic to start`);
  return { exitCode: EXIT_OK };
}
