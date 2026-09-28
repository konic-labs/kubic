// Shared types of the command registry: the injected runners (one per
// command seam, production wiring in ../prod-runners.ts) and the context
// every command module's `register*Commands(program, ctx)` receives.

import type { Command } from '@commander-js/extra-typings';
import type { CliConfigResult } from '../config-runtime.js';

// `rest` is the argv after the command name — journal commands receive
// `[command, ...rest]`; `config` is the one process-wide config load, so
// every runner reads the same result the refusal gate saw.
export type CommandRunner = (
  rest: readonly string[],
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
  readonly orchestrate: CommandRunner;
  readonly clean: CommandRunner;
  readonly cost: CommandRunner;
  readonly perf: CommandRunner;
  readonly policy: CommandRunner;
  readonly config: CommandRunner;
  readonly audit: CommandRunner;
  readonly workers: CommandRunner;
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
