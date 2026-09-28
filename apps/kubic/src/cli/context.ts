// Shared types of the command registry: the injected runners (one per
// command seam, production wiring in ../prod-runners.ts) and the context
// every command module's `register*Commands(program, ctx)` receives.

import type { Command } from '@commander-js/extra-typings';
import type { OrchestrateCliOptions } from '../../../../packages/host/src/orchestrate-cli.js';
import type { CleanOptions } from '../../../../packages/host/src/orchestrator/worktree/clean.js';
import type { WorkersCliOptions } from '../../../../packages/host/src/workers-cli.js';
import type { CliConfigResult } from '../config-runtime.js';

// `args` is what the command hands its handler: for a pass-through
// forwarder the argv after the command name (journal commands receive
// `[command, ...rest]`); for a migrated command the options commander
// parsed. `config` is the one process-wide config load, so every runner
// reads the same result the refusal gate saw.
export type CommandRunner<Args = readonly string[]> = (
  args: Args,
  config: CliConfigResult,
) => number | Promise<number>;

export interface DispatchRunners {
  readonly sessions: CommandRunner;
  readonly git: CommandRunner;
  readonly journal: CommandRunner;
  readonly models: CommandRunner;
  readonly run: CommandRunner;
  readonly tui: CommandRunner;
  readonly doctor: CommandRunner;
  readonly orchestrate: CommandRunner<OrchestrateCliOptions>;
  readonly clean: CommandRunner<CleanOptions>;
  readonly cost: CommandRunner;
  readonly perf: CommandRunner;
  readonly policy: CommandRunner;
  readonly config: CommandRunner;
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
