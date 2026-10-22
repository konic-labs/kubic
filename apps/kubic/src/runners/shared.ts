// What the production runners share: the two output channels, each
// command's presentation (colour, tables, the diagnostics logger) decided
// from the real streams, and the audit-sink reachability probes.

import { createSocket } from 'node:dgram';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import type { CliLogger } from '@kubic/core/cli/logger';
import { createLineLogger, debugEnabled } from '@kubic/core/cli/logger';
import { outputModeFor } from '@kubic/core/cli/output';
import type { CliTheme } from '@kubic/core/cli/theme';
import {
  createCliTheme,
  detectColorLevel,
  themeFor,
} from '@kubic/core/cli/theme';
import { isUnixSocket } from '@kubic/exec/syslog-logger';
import { unixSyslogTransportProblem } from '@kubic/host/audit';
import type { CliConfigResult } from '../config/load.js';
import { runtimeModelPinNotes } from '../config/model-selection.js';
import type { DispatchRunners } from '../dispatch.js';

// The two channels the root wired: `kubic` output on stdout, diagnostics
// (debug lines) on stderr.
export interface ProdRunnerIo {
  readonly out: (line: string) => void;
  readonly debug: (line: string) => void;
  // The version the TUI's first screen names.
  readonly version?: () => string;
}

export type ProdRunners = DispatchRunners;

// The presentation seams of one command invocation, derived once from
// the real streams: colour for stdout data (none off a TTY, under NO_COLOR,
// or for --json), the stderr diagnostics logger (debug lines under
// KUBIC_DEBUG=1), kit tables and prompts only on an interactive
// terminal. `--json` keeps stdout to exactly one document.
export function presentation(
  out: (line: string) => void,
  diagnostics: (line: string) => void,
  json: boolean,
): {
  out: (line: string) => void;
  logger: CliLogger;
  theme: ReturnType<typeof createCliTheme>;
  fancy: boolean;
  interactive: boolean;
} {
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinTTY = process.stdin.isTTY === true;
  const theme = createCliTheme(
    json ? 'none' : detectColorLevel(process.env, stdoutTTY),
  );
  const logTheme = json ? PLAIN : stderrTheme();
  const mode = outputModeFor({
    json,
    stdinTTY,
    stdoutTTY,
    colorEnabled: theme.enabled,
  });
  return {
    out,
    logger: createLineLogger(diagnostics, {
      theme: logTheme,
      debug: debugEnabled({}),
    }),
    theme,
    fancy: mode.fancy,
    interactive: mode.interactive,
  };
}

// The diagnostics colours for stderr, decided from stderr's own TTY state
// (the logger contract: colour only on a TTY) — never from stdout's.
export function stderrTheme(): CliTheme {
  return themeFor(process.stderr);
}

export const PLAIN = createCliTheme('none');

// Audit-sink reachability probes: the real platform — a
// unix syslog target must be a socket the system logger can reach; UDP needs
// a creatable dgram socket (connectionless, so delivery stays best-effort
// past this point).
export const auditProbes = {
  socketExists: isUnixSocket,
  unixTransportProblem: unixSyslogTransportProblem,
  udpAvailable: (): boolean => {
    try {
      createSocket('udp4').close();
      return true;
    } catch {
      return false;
    }
  },
};

// Report colours and table style for a migrated command, decided once from
// the real stdout: colour only on a TTY that allows it (NO_COLOR,
// FORCE_COLOR, TERM=dumb honoured), kit tables only there too, and
// neither under `--json`.
export function reportStyle(json: boolean): {
  theme: CliTheme;
  fancy: boolean;
} {
  const theme = json ? PLAIN : themeFor(process.stdout);
  const mode = outputModeFor({
    json,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    colorEnabled: theme.enabled,
  });
  return { theme, fancy: mode.fancy };
}

// The analysis handlers' channels: the report on stdout, diagnostics on
// stderr (the `debug` channel), report colour and the kit table from the
// real stdout, diagnostics colour from the real stderr (each off on a
// pipe and under NO_COLOR; each handler also drops them under --json).
export function analysisReport(io: ProdRunnerIo) {
  const theme = themeFor(process.stdout);
  return {
    out: io.out,
    err: io.debug,
    theme,
    errTheme: stderrTheme(),
    fancy: outputModeFor({
      json: false,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      colorEnabled: theme.enabled,
    }).fancy,
  };
}

// A frozen enterprise `[model]` drops a cli/env pin; the
// boot of every agent-running command says so once, on stderr — never on
// stdout, so a `--json` envelope stays exactly one document.
export function noteOverriddenModelPins(
  io: ProdRunnerIo,
  cliConfig: CliConfigResult,
): void {
  for (const line of runtimeModelPinNotes(cliConfig)) io.debug(line);
}

// A usage refusal the handler never sees: one `error:` line, exit 2.
export function usageError(io: ProdRunnerIo, message: string): CommandResult {
  createLineLogger(io.debug, { theme: stderrTheme() }).error(message);
  return { exitCode: EXIT_USAGE };
}
