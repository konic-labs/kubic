// Shared types of the command registry: the injected runners (one per
// command seam, production wiring in ../prod-runners.ts) and the context
// every command module's `register*Commands(program, ctx)` receives.

import type { Command } from '@commander-js/extra-typings';
import type { ConfigCommandOptions } from '../../../../packages/host/src/config/config-cli.js';
import type { DoctorCommandOptions } from '../../../../packages/host/src/doctor.js';
import type { GitRequest } from '../../../../packages/host/src/git-cli.js';
import type { JournalRequest } from '../../../../packages/host/src/journal-cli.js';
import type { ModelsCommandOptions } from '../../../../packages/host/src/models-cli.js';
import type { RunCommandOptions } from '../../../../packages/host/src/run-cli.js';
import type { SessionsInvocation } from '../../../../packages/host/src/sessions-cli.js';
import type { SetupCommandOptions } from '../../../../packages/host/src/setup-cli.js';
import type { SkillsCommandOptions } from '../../../../packages/host/src/skills-cli.js';
import type { TrustCommandOptions } from '../../../../packages/host/src/trust-cli.js';
import type { AnalysisRunners } from '../commands/analysis.js';
import type { CliConfigResult } from '../config-runtime.js';
import type { TuiCommandOptions } from '../tui-run.js';

// A command's runner takes the options commander parsed (the `Input`
// parameter). `config` is the one process-wide config load, so every runner
// reads the same result the refusal gate saw.
type CommandRunner<Input> = (
  rest: Input,
  config: CliConfigResult,
) => number | Promise<number>;

// Migrated command groups may declare their typed runners in their own
// module (the analysis group's `AnalysisRunners`).
export interface DispatchRunners extends AnalysisRunners {
  readonly sessions: CommandRunner<SessionsInvocation>;
  readonly git: CommandRunner<GitRequest>;
  readonly journal: CommandRunner<JournalRequest>;
  readonly models: CommandRunner<ModelsCommandOptions>;
  readonly run: CommandRunner<RunCommandOptions>;
  readonly tui: CommandRunner<TuiCommandOptions>;
  readonly doctor: CommandRunner<DoctorCommandOptions>;
  readonly skills: CommandRunner<SkillsCommandOptions>;
  readonly config: CommandRunner<ConfigCommandOptions>;
  readonly trust: CommandRunner<TrustCommandOptions>;
  // The interactive first-run setup.
  readonly setup: CommandRunner<SetupCommandOptions>;
}

// The root commander program every registrar attaches to.
export type KubicProgram = Command;

export interface CommandContext {
  readonly config: CliConfigResult;
  readonly runners: DispatchRunners;
  // Raw argv after the command token, untouched by commander (it drops a
  // leading `--`). Commands read commander's parsed values; only `run`'s
  // prompt typo guard inspects the raw spelling.
  readonly rest: readonly string[];
  // stdout (data) and stderr (diagnostics) line channels.
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  // The process exit code of this invocation; an action sets it once.
  readonly setExitCode: (code: number) => void;
}

export type CommandRegistrar = (
  program: KubicProgram,
  ctx: CommandContext,
) => void;
