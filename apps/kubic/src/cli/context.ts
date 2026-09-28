// Shared types of the command registry: the injected runners (one per
// command seam, production wiring in ../prod-runners.ts) and the context
// every command module's `register*Commands(program, ctx)` receives.

import type { Command } from '@commander-js/extra-typings';
import type { ConfigCommandOptions } from '../../../../packages/host/src/config/config-cli.js';
import type { DoctorCommandOptions } from '../../../../packages/host/src/doctor.js';
import type { GitRequest } from '../../../../packages/host/src/git-cli.js';
import type { JournalRequest } from '../../../../packages/host/src/journal-cli.js';
import type { ModelsCommandOptions } from '../../../../packages/host/src/models-cli.js';
import type { OrchestrateCliOptions } from '../../../../packages/host/src/orchestrate-cli.js';
import type { CleanOptions } from '../../../../packages/host/src/orchestrator/worktree/clean.js';
import type { RunCommandOptions } from '../../../../packages/host/src/run-cli.js';
import type { SessionsInvocation } from '../../../../packages/host/src/sessions-cli.js';
import type { WorkersCliOptions } from '../../../../packages/host/src/workers-cli.js';
import type { CliConfigResult } from '../config-runtime.js';
import type { TuiCommandOptions } from '../tui-run.js';

// A forwarded runner's `rest` is the argv after the command name; a
// migrated command's runner takes the options commander parsed instead (the
// `Input` parameter). `config` is the one process-wide config load, so every
// runner reads the same result the refusal gate saw.
export type CommandRunner<Input = readonly string[]> = (
  rest: Input,
  config: CliConfigResult,
) => number | Promise<number>;

export interface DispatchRunners {
  readonly sessions: CommandRunner<SessionsInvocation>;
  readonly git: CommandRunner<GitRequest>;
  readonly journal: CommandRunner<JournalRequest>;
  readonly models: CommandRunner<ModelsCommandOptions>;
  readonly run: CommandRunner<RunCommandOptions>;
  readonly tui: CommandRunner<TuiCommandOptions>;
  readonly doctor: CommandRunner<DoctorCommandOptions>;
  readonly orchestrate: CommandRunner<OrchestrateCliOptions>;
  readonly clean: CommandRunner<CleanOptions>;
  readonly cost: CommandRunner;
  readonly perf: CommandRunner;
  readonly policy: CommandRunner;
  readonly config: CommandRunner<ConfigCommandOptions>;
  readonly audit: CommandRunner;
  readonly workers: CommandRunner<WorkersCliOptions>;
  readonly eval: CommandRunner;
  readonly benchmark: CommandRunner;
  readonly replay: CommandRunner;
  readonly export: CommandRunner;
}

// The root commander program every registrar attaches to.
export type KubicProgram = Command;

export interface CommandContext {
  readonly config: CliConfigResult;
  readonly runners: DispatchRunners;
  // Raw argv after the command token, untouched by commander (it drops a
  // leading `--`). Only the pass-through forwarders read it; a migrated
  // command declares real options and reads commander's parsed values.
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
