// The dispatch front door over recording runners: what each command
// reached, what it printed, and how it exited, over one loaded fixture config.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { NO_PROJECT_TRUST } from '@kubic/host/config';
import type { CliConfigResult } from '../config/load.js';
import { loadCliConfig } from '../config/load.js';
import type { DispatchDeps, DispatchRunners } from '../dispatch.js';

export type RunnerKey = keyof DispatchRunners;

// The runner roster: one entry per command seam the root wires inline
// (23 command names, 17 runners — the four journal commands share one).
export const RUNNER_KEYS: readonly RunnerKey[] = [
  'sessions',
  'git',
  'journal',
  'models',
  'run',
  'tui',
  'doctor',
  'skills',
  'cost',
  'policy',
  'config',
  'trust',
  'audit',
  'eval',
  'benchmark',
  'replay',
  'export',
];

// Every runner receives the options commander parsed.
export type AnyRunner = (
  input: unknown,
  config: CliConfigResult,
) => CommandResult | Promise<CommandResult>;

interface RunnerCall {
  readonly key: RunnerKey;
  // The options commander parsed for the command.
  readonly rest: unknown;
  readonly config: CliConfigResult;
}

export interface Harness {
  readonly deps: DispatchDeps;
  readonly calls: RunnerCall[];
  readonly lines: string[];
  // The options each `loadConfig` call received (the accepted
  // trust answer is threaded into the load as an explicit decision).
  readonly loadOptions: ReadonlyArray<{ projectTrusted?: boolean } | undefined>;
  readonly state: {
    excludeCalls: number;
    excludeEntries: readonly string[] | undefined;
  };
}

// A dispatch over fully faux runners: every runner records its call and
// answers 0 unless overridden. `out`/`ensureRuntimeExclude` are captured,
// `version` is a constant, `loadConfig` answers the given result.
export function harness(
  options: {
    runners?: Partial<Record<RunnerKey, AnyRunner>>;
    config?: CliConfigResult;
    version?: string;
    interactive?: boolean;
    resolveTrust?: () => Promise<boolean | undefined>;
  } = {},
): Harness {
  const calls: RunnerCall[] = [];
  const lines: string[] = [];
  const loadOptions: Array<{ projectTrusted?: boolean } | undefined> = [];
  const state: Harness['state'] = {
    excludeCalls: 0,
    excludeEntries: undefined,
  };
  const runners = {} as Record<RunnerKey, AnyRunner>;
  for (const key of RUNNER_KEYS) {
    const override = options.runners?.[key];
    runners[key] = (rest, config) => {
      calls.push({
        key,
        rest: Array.isArray(rest) ? [...(rest as string[])] : rest,
        config,
      });
      return override === undefined ? { exitCode: 0 } : override(rest, config);
    };
  }
  const deps: DispatchDeps = {
    out: (line) => {
      lines.push(line);
    },
    loadConfig: (load) => {
      loadOptions.push(load);
      return options.config ?? loadedConfig();
    },
    version: () => options.version ?? '9.9.9',
    ensureRuntimeExclude: (entries) => {
      state.excludeCalls += 1;
      state.excludeEntries = entries;
    },
    runners: runners as unknown as DispatchRunners,
    isInteractive: () => options.interactive === true,
    ...(options.resolveTrust === undefined
      ? {}
      : { resolveProjectTrust: options.resolveTrust }),
  };
  return { deps, calls, lines, loadOptions, state };
}

// The refused load's shape (what loadCliConfig returns for a broken
// config): runtime absent, named reason present.
export function refusedConfig(error = 'unknown key [nope]'): CliConfigResult {
  return {
    runtime: undefined,
    error,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

// Fixture home/cwd for the real config load and the prod cost store: an
// empty dir has no config files, so the documented defaults load.
export const FIXTURE = mkdtempSync(join(tmpdir(), 'kubic-dispatch-'));

let loadedOnce: CliConfigResult | undefined;

// A real loaded result over the fixture (no files → defaults). The
// dispatch only distinguishes present-vs-absent; runner fakes ignore it.
export function loadedConfig(): CliConfigResult {
  loadedOnce ??= loadCliConfig({ cwd: FIXTURE, home: FIXTURE, env: {} });
  if (loadedOnce.runtime === undefined) {
    throw new Error(
      `fixture config load refused: ${loadedOnce.error ?? 'unknown reason'}`,
    );
  }
  return loadedOnce;
}
