// Shared types of the command registry: the injected runners (one per
// command seam, production wiring in ../prod-runners.ts) and the context
// every command module's `register*Commands(program, ctx)` receives.

import type { Command } from '@commander-js/extra-typings';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import type {
  ConfigCommandOptions,
  SetupCommandOptions,
  TrustCommandOptions,
} from '@kubic/host/config';
import type { DoctorCommandOptions } from '@kubic/host/doctor';
import type { GitRequest } from '@kubic/host/git';
import type { JournalRequest } from '@kubic/host/journal';
import type { ModelsCommandOptions } from '@kubic/host/models';
import type { RunCommandOptions } from '@kubic/host/run';
import type { SessionsInvocation } from '@kubic/host/sessions';
import type { SkillsCommandOptions } from '@kubic/host/skills';
import type { AnalysisRunners } from '../commands/analysis.js';
import type { CliConfigResult } from '../config/load.js';
import type { TuiCommandOptions } from '../tui/options.js';

// A command's runner takes the options commander parsed (the `Input`
// parameter). `config` is the one process-wide config load, so every runner
// reads the same result the refusal gate saw. It returns the command's
// result; the dispatcher turns its exit code into the process exit code.
type CommandRunner<Input> = (
  rest: Input,
  config: CliConfigResult,
) => CommandResult | Promise<CommandResult>;

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
  // Records the result of this invocation's command. The dispatcher reads the
  // process exit code from it; an action calls this once.
  readonly finish: (result: CommandResult) => void;
}

export type CommandRegistrar = (
  program: KubicProgram,
  ctx: CommandContext,
) => void;
