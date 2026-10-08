// Dispatch wiring suite: the composition root's front door — which command
// routes to which runner, the config-refusal matrix, the exit codes, and
// the front-door special cases — over injected
// runners. Faux everything: no real lanes, no network, and no fs beyond the
// one fixture dir this file creates.
//
// The `prod wiring deps shapes` block drives the REAL production runners
// (./prod-runners.js) over hermetic argv and fixtures on purpose: it pins
// the documented deps shapes the root wires (cost {loadRows,out}, audit
// {loadRecords,loadSecrets,out}, export {readFile,out})
// and the eval runSuite refusal message, verbatim.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { CommandResult } from '../../../packages/core/src/cli/exit-codes.js';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import { RUNTIME_EXCLUDE_ENTRIES } from '../../../packages/exec/src/runtime-exclude.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import {
  type CliConfigResult,
  CONFIG_CONSUMING_COMMANDS,
  loadCliConfig,
} from './config-runtime.js';
import {
  type DispatchDeps,
  type DispatchRunners,
  dispatchCommand,
  ROOT_HELP,
} from './dispatch.js';
import { createProdRunners } from './prod-runners.js';

type RunnerKey = keyof DispatchRunners;

// The runner roster: one entry per command seam the root wires inline
// (23 command names, 17 runners — the four journal commands share one).
const RUNNER_KEYS: readonly RunnerKey[] = [
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

// Every command in the if-chain, the argv it is dispatched with, and the
// runner it must reach. Journal commands receive `[command, ...rest]` —
// the argv the root passed before the extraction.
const ROUTES: readonly (readonly [string, readonly string[], RunnerKey])[] = [
  ['sessions', ['list'], 'sessions'],
  ['git', ['status'], 'git'],
  ['commit', ['-m', 'msg'], 'git'],
  ['diff', ['--json'], 'journal'],
  ['undo', ['--step'], 'journal'],
  ['log', [], 'journal'],
  ['status', [], 'journal'],
  ['models', ['--json'], 'models'],
  ['run', ['-p', 'hi'], 'run'],
  ['tui', [], 'tui'],
  ['attach', ['abc'], 'tui'],
  ['resume', ['abc'], 'tui'],
  ['doctor', [], 'doctor'],
  ['skills', ['--json'], 'skills'],
  ['cost', ['--json'], 'cost'],
  ['policy', ['--tool', 'shell'], 'policy'],
  ['config', ['--json'], 'config'],
  ['trust', [], 'trust'],
  ['audit', [], 'audit'],
  ['eval', ['--suite', 'swe-bench-mini', '--task', 'p'], 'eval'],
  ['benchmark', [], 'benchmark'],
  ['replay', ['t.json', '--tier', 'recorded'], 'replay'],
  ['export', ['--trajectory', 'trajectory.json'], 'export'],
];

// Commands migrated to real commander definitions (commands/*.ts): their
// runner receives the parsed options for the ROUTES argv, never argv.
const PARSED: Readonly<Record<string, unknown>> = {
  sessions: { command: 'list' },
  models: { json: true },
  run: { prompt: 'hi' },
  tui: {},
  attach: { session: 'abc' },
  resume: { session: 'abc' },
  commit: { command: 'commit', message: 'msg' },
  doctor: { skip: [] },
  skills: { json: true },
  config: { json: true },
  trust: {},
  git: { command: 'status' },
  diff: { command: 'diff', json: true },
  undo: { command: 'undo', step: true },
  log: { command: 'log' },
  status: { command: 'status' },
  cost: { json: true },
  policy: { tool: 'shell' },
  audit: {},
  // No commander model default on eval — the handler applies it on
  // the --task path; --trajectory reads the model from the export.
  eval: {
    suite: 'swe-bench-mini',
    task: 'p',
  },
  benchmark: { model: 'faux/echo' },
  replay: { trajectory: 't.json', tier: 'recorded' },
  export: { trajectory: 'trajectory.json' },
};

// Every runner receives the options commander parsed.
type AnyRunner = (
  input: unknown,
  config: CliConfigResult,
) => CommandResult | Promise<CommandResult>;

interface RunnerCall {
  readonly key: RunnerKey;
  // The options commander parsed for the command.
  readonly rest: unknown;
  readonly config: CliConfigResult;
}

interface Harness {
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
function harness(
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

// Fixture home/cwd for the real config load and the prod cost store: an
// empty dir has no config files, so the documented defaults load.
const FIXTURE = mkdtempSync(join(tmpdir(), 'kubic-dispatch-'));
afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

// The refused load's shape (what loadCliConfig returns for a broken
// config): runtime absent, named reason present.
function refusedConfig(error = 'unknown key [nope]'): CliConfigResult {
  return {
    runtime: undefined,
    error,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

// The defensive no-reason shape (the `config refused` fallback path).
function refusedConfigWithoutReason(): CliConfigResult {
  return {
    runtime: undefined,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

let loadedOnce: CliConfigResult | undefined;

// A real loaded result over the fixture (no files → defaults). The
// dispatch only distinguishes present-vs-absent; runner fakes ignore it.
function loadedConfig(): CliConfigResult {
  loadedOnce ??= loadCliConfig({ cwd: FIXTURE, home: FIXTURE, env: {} });
  if (loadedOnce.runtime === undefined) {
    throw new Error(
      `fixture config load refused: ${loadedOnce.error ?? 'unknown reason'}`,
    );
  }
  return loadedOnce;
}

describe('dispatch routing', () => {
  it('pins the roster: 23 commands, 17 runners, every runner exercised', () => {
    expect(ROUTES).toHaveLength(23);
    expect(RUNNER_KEYS).toHaveLength(17);
    const routed = new Set(ROUTES.map(([, , key]) => key));
    expect([...routed].sort()).toEqual([...RUNNER_KEYS].sort());
  });

  it('routes every command in the if-chain to its injected runner', async () => {
    for (const [command, rest, key] of ROUTES) {
      const h = harness();
      const code = await dispatchCommand(command, rest, h.deps);
      const label = `\`${command}\` must route to the ${key} runner`;
      expect(
        h.calls.map((call) => call.key),
        label,
      ).toEqual([key]);
      expect(h.calls[0]?.rest, label).toEqual(PARSED[command] ?? rest);
      expect(code, `${label} — exit code must flow back`).toBe(0);
    }
  });

  it('returns the runner exit code verbatim', async () => {
    const h = harness({ runners: { sessions: () => ({ exitCode: 5 }) } });
    expect(await dispatchCommand('sessions', ['list'], h.deps)).toBe(5);
  });

  it('hands the runner the process-wide config load', async () => {
    const config = loadedConfig();
    const h = harness({ config });
    await dispatchCommand('models', [], h.deps);
    expect(h.calls[0]?.config).toBe(config);
  });

  it('falls through to the usage line for a command outside the table (usage, exit 2)', async () => {
    const h = harness();
    expect(await dispatchCommand('definitely-not-a-command', [], h.deps)).toBe(
      2,
    );
    expect(h.lines).toEqual([
      "error: unknown command 'definitely-not-a-command'",
      "hint: to run it as a prompt: kubic run -p 'definitely-not-a-command'",
      'hint: kubic --help lists the commands',
    ]);
    expect(h.calls).toEqual([]);
  });

  it('a bare multi-word prompt is `kubic run -p <prompt>`', async () => {
    const h = harness();
    expect(
      await dispatchCommand('fix the authentication bug', [], h.deps),
    ).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([
      ['run', { prompt: 'fix the authentication bug' }],
    ]);
    // The prompt form is a state-creating mode: the exclude rules ship.
    expect(h.state.excludeCalls).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it('a bare prompt carries trailing flags through', async () => {
    const h = harness();
    expect(await dispatchCommand('do x', ['--json'], h.deps)).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([
      ['run', { prompt: 'do x', json: true }],
    ]);
  });

  it('a single-word unknown token stays an unknown command with the prompt hint', async () => {
    const h = harness();
    expect(await dispatchCommand('nosuch', [], h.deps)).toBe(2);
    expect(h.lines).toEqual([
      "error: unknown command 'nosuch'",
      "hint: to run it as a prompt: kubic run -p 'nosuch'",
      'hint: kubic --help lists the commands',
    ]);
    expect(h.calls).toEqual([]);
  });

  it('an empty token gets no dead-end hint (review finding)', async () => {
    // `kubic ""` cannot be run as a prompt (the prompt is empty), so the
    // hint would name a command that exits 2 again.
    const h = harness();
    expect(await dispatchCommand('', [], h.deps)).toBe(2);
    expect(h.lines).toEqual([
      "error: unknown command ''",
      'hint: kubic --help lists the commands',
    ]);
    expect(h.calls).toEqual([]);
  });
});

describe('front door', () => {
  it('--version prints the version line from the injected version', async () => {
    const h = harness({ version: '9.9.9' });
    expect(await dispatchCommand('--version', [], h.deps)).toBe(0);
    expect(h.lines).toEqual(['kubic 9.9.9 (license: MIT)']);
    expect(h.calls).toEqual([]);
  });

  it('-V is the same version path', async () => {
    const h = harness({ version: '1.2.3' });
    expect(await dispatchCommand('-V', [], h.deps)).toBe(0);
    expect(h.lines).toEqual(['kubic 1.2.3 (license: MIT)']);
  });

  it('--help and -h answer the root usage with exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const h = harness();
      expect(await dispatchCommand(flag, [], h.deps), flag).toBe(0);
      expect(h.lines, flag).toEqual([ROOT_HELP]);
      expect(h.calls, flag).toEqual([]);
    }
  });

  it('the bare invocation prints the usage and exits 1 (POSIX posture)', async () => {
    const h = harness();
    expect(await dispatchCommand(undefined, [], h.deps)).toBe(1);
    expect(h.lines).toEqual([ROOT_HELP]);
    expect(h.calls).toEqual([]);
  });

  it('the bare invocation on an interactive terminal opens the TUI', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand(undefined, [], deps)).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([['tui', {}]]);
    // Same boot as `kubic tui`: the runtime ignore rules ship first.
    expect(h.state.excludeCalls).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it('bare `kubic --dangerously-skip-approvals` on a TTY is `kubic tui --dangerously-skip-approvals`', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => true };
    expect(
      await dispatchCommand('--dangerously-skip-approvals', [], deps),
    ).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([
      ['tui', { dangerouslySkipApprovals: true }],
    ]);
    expect(h.state.excludeCalls).toBe(1);
  });

  it('bare `kubic --dangerously-skip-approvals` off a TTY keeps usage + exit 1', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => false };
    expect(
      await dispatchCommand('--dangerously-skip-approvals', [], deps),
    ).toBe(1);
    expect(h.lines).toEqual([ROOT_HELP]);
    expect(h.calls).toEqual([]);
  });

  // Bare `kubic --model p/id` on a TTY is `kubic tui --model`.
  it('routes a bare --model on an interactive terminal to the TUI', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand('--model', ['faux/b'], deps)).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([
      ['tui', { model: { provider: 'faux', id: 'b' } }],
    ]);
    // Off a TTY it stays the usage + exit 1 posture.
    const off = harness();
    expect(
      await dispatchCommand('--model', ['faux/b'], {
        ...off.deps,
        isInteractive: () => false,
      }),
    ).toBe(1);
    expect(off.calls).toEqual([]);
  });

  it('the bare invocation off a TTY keeps the usage + exit 1 posture', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => false };
    expect(await dispatchCommand(undefined, [], deps)).toBe(1);
    expect(h.lines).toEqual([ROOT_HELP]);
    expect(h.calls).toEqual([]);
  });

  it('a refused config stops the bare interactive TUI like `kubic tui`', async () => {
    const h = harness({ config: refusedConfig() });
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand(undefined, [], deps)).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('throws from the gated crash probe (contract seam)', async () => {
    process.env.__KUBIC_CONTRACT_CRASH_PROBE = '1';
    try {
      await expect(
        dispatchCommand('__crash-probe', [], harness().deps),
      ).rejects.toThrow('injected probe failure');
    } finally {
      delete process.env.__KUBIC_CONTRACT_CRASH_PROBE;
    }
  });

  it('an ungated crash probe is just an unknown command (usage, exit 2)', async () => {
    delete process.env.__KUBIC_CONTRACT_CRASH_PROBE;
    const h = harness();
    expect(await dispatchCommand('__crash-probe', [], h.deps)).toBe(2);
    expect(h.lines).toEqual([
      "error: unknown command '__crash-probe'",
      'hint: kubic --help lists the commands',
    ]);
    expect(h.calls).toEqual([]);
  });

  it('an unknown root option is a usage error; `help` names the prompt form (usage, exit 2)', async () => {
    for (const command of ['--bogus', '-x']) {
      const h = harness();
      expect(await dispatchCommand(command, [], h.deps), command).toBe(2);
      expect(h.lines, command).toEqual([
        `error: unknown option '${command}'`,
        'hint: kubic --help lists the commands and options',
      ]);
      expect(h.calls, command).toEqual([]);
    }
    // `help` and `version` point at the real flags, never at
    // the prompt form; a typo names the closest command.
    const help = harness();
    expect(await dispatchCommand('help', [], help.deps)).toBe(2);
    expect(help.lines).toEqual([
      "error: unknown command 'help'",
      'hint: kubic --help lists the commands',
    ]);
    const version = harness();
    expect(await dispatchCommand('version', [], version.deps)).toBe(2);
    expect(version.lines).toEqual([
      "error: unknown command 'version'",
      'hint: kubic --version prints the version',
      'hint: kubic --help lists the commands',
    ]);
    const typo = harness();
    expect(await dispatchCommand('stauts', [], typo.deps)).toBe(2);
    expect(typo.lines).toEqual([
      "error: unknown command 'stauts'",
      'hint: did you mean kubic status?',
      'hint: kubic --help lists the commands',
    ]);
  });

  it('runs the first-run setup only for a bare interactive kubic', async () => {
    let asked = 0;
    const firstRunSetup = async (): Promise<CommandResult | undefined> => {
      asked += 1;
      return { exitCode: 6 };
    };
    const bare = harness({ interactive: true });
    expect(
      await dispatchCommand(undefined, [], { ...bare.deps, firstRunSetup }),
    ).toBe(6);
    expect(asked).toBe(1);
    expect(bare.calls).toEqual([]);
    const command = harness({ interactive: true });
    await dispatchCommand('doctor', [], { ...command.deps, firstRunSetup });
    const piped = harness();
    await dispatchCommand(undefined, [], { ...piped.deps, firstRunSetup });
    expect(asked).toBe(1);
  });

  it('renders a usage error as an error block on a colour terminal', async () => {
    const h = harness();
    const theme = createCliTheme('truecolor');
    expect(
      await dispatchCommand('stauts', [], {
        ...h.deps,
        errorTheme: () => theme,
      }),
    ).toBe(2);
    expect(h.lines[0]).toBe(
      `${theme.ui.fg('err')('✕')} ${theme.ui.style({ fg: 'err', bold: true })('unknown command')} ${theme.ui.fg('fg0')('stauts')}`,
    );
    expect(h.lines[1]).toContain(theme.ui.fg('fg1')('kubic status'));
    expect(h.lines.at(-1)).toBe(`  ${theme.ui.fg('fg3')('exit 2 · usage')}`);
  });

  it('root options after the command reach the command (positional options)', async () => {
    // `--help` after a command is that command's generated help, never the
    // root listing; `-V` after it is the command's (unknown) option, never
    // the root version.
    const help = harness();
    expect(await dispatchCommand('doctor', ['--help'], help.deps)).toBe(0);
    expect(help.calls).toEqual([]);
    expect(help.lines.join('\n')).toContain('Usage: kubic doctor');
    expect(help.lines).not.toContain(ROOT_HELP);
    const version = harness();
    expect(await dispatchCommand('doctor', ['-V'], version.deps)).toBe(2);
    expect(version.calls).toEqual([]);
    expect(version.lines.join('\n')).toContain("unknown option '-V'");
  });
});

describe('config refusal', () => {
  // policy consumes a config projection (the installed posture a run
  // enforces), so a refused config must stop it like the agent-executing
  // modes.
  // attach/resume boot the same TUI lane as tui, and eval/benchmark run
  // agent lanes under the same projections — all fail closed here.
  const CONSUMING = [
    'run',
    'tui',
    'attach',
    'resume',
    'replay',
    'policy',
    'eval',
    'benchmark',
  ];
  const REPORTING = ['config', 'doctor', 'skills', 'trust'];

  it('pins gate membership: the gate is exactly the refused commands', () => {
    // A new command whose runner reads cliConfig.runtime must join the
    // gate here — or be a reporting command, or take the documented
    // sessions/journal retention fallback. run, tui (+attach/resume
    // aliases), replay, policy (installed posture) and eval/benchmark (lane
    // projections) read runtime; config/doctor/skills/trust report it;
    // sessions/journal read only sessionRetentionDays (undefined-safe
    // fallback); models reads only the trust report (present on refusal);
    // git, cost, audit and export read no config at all.
    expect([...CONFIG_CONSUMING_COMMANDS].sort()).toEqual(
      [...CONSUMING].sort(),
    );
  });

  it('refuses the agent-executing modes with exit 1 and the named reason', async () => {
    for (const command of CONSUMING) {
      const h = harness({ config: refusedConfig('unknown key [nope]') });
      const code = await dispatchCommand(command, [], h.deps);
      expect(code, command).toBe(1);
      expect(h.lines, command).toEqual(['error: unknown key [nope]']);
      expect(h.calls, `${command} must not reach a runner`).toEqual([]);
    }
  });

  it('still runs the reporting commands so the reason can surface', async () => {
    for (const command of REPORTING) {
      const h = harness({ config: refusedConfig() });
      expect(await dispatchCommand(command, [], h.deps), command).toBe(0);
      expect(
        h.calls.map((call) => call.key),
        command,
      ).toEqual([command]);
      expect(h.lines, command).toEqual([]);
    }
  });

  it('lets every other command proceed', async () => {
    const others = ROUTES.filter(
      ([command]) =>
        !CONSUMING.includes(command) && !REPORTING.includes(command),
    );
    expect(others).toHaveLength(11);
    // Each with its ROUTES argv: a bare `kubic git` is a usage error.
    for (const [command, rest] of others) {
      const h = harness({ config: refusedConfig() });
      expect(await dispatchCommand(command, rest, h.deps), command).toBe(0);
      expect(h.calls, `${command} must reach its runner`).toHaveLength(1);
      expect(h.lines, `${command} must not print a refusal`).toEqual([]);
    }
  });

  it('prints the refusal on stderr, keeping stdout for data without --json', async () => {
    const h = harness({ config: refusedConfig('unknown key [nope]') });
    const errs: string[] = [];
    const deps = { ...h.deps, err: (line: string) => errs.push(line) };
    expect(await dispatchCommand('run', ['-p', 'hi'], deps)).toBe(1);
    expect(h.lines).toEqual([]);
    expect(errs).toEqual(['error: unknown key [nope]']);
  });

  it('prints the command’s failure envelope on stdout under --json', async () => {
    const cases: Array<{
      command: string;
      rest: string[];
      check: (envelope: Record<string, unknown>) => void;
    }> = [
      {
        command: 'run',
        rest: ['-p', 'hi', '--json'],
        check: (envelope) => {
          expect(envelope.status).toBe('failed');
          expect(envelope.sessionId).toBe('unassigned');
          expect(envelope.result).toEqual({ summary: 'unknown key [nope]' });
          expect(envelope.error).toEqual({
            kind: 'failed',
            message: 'unknown key [nope]',
          });
        },
      },
      {
        command: 'replay',
        rest: ['t.json', '--json'],
        check: (envelope) => {
          expect(envelope.tier).toBe('unknown');
          expect(envelope.error).toEqual({
            code: 'config_refused',
            message: 'unknown key [nope]',
          });
        },
      },
    ];
    for (const { command, rest, check } of cases) {
      const h = harness({ config: refusedConfig('unknown key [nope]') });
      const errs: string[] = [];
      const deps = { ...h.deps, err: (line: string) => errs.push(line) };
      expect(await dispatchCommand(command, rest, deps), command).toBe(1);
      expect(errs, command).toEqual(['error: unknown key [nope]']);
      expect(h.lines, command).toHaveLength(1);
      const envelope = JSON.parse(h.lines[0] as string) as Record<
        string,
        unknown
      >;
      expect(envelope.ok, command).toBe(false);
      expect(envelope.exitCode, command).toBe(1);
      check(envelope);
      expect(h.calls, `${command} must not reach a runner`).toEqual([]);
    }
  });

  it('a refusal without --json stays stdout-empty for every consuming command', async () => {
    const cases: Array<[string, string[]]> = [
      ['run', ['-p', 'hi']],
      ['replay', ['t.json']],
      ['tui', []],
      ['policy', ['--tool', 'shell']],
    ];
    for (const [command, rest] of cases) {
      const h = harness({ config: refusedConfig('unknown key [nope]') });
      const errs: string[] = [];
      const deps = { ...h.deps, err: (line: string) => errs.push(line) };
      expect(await dispatchCommand(command, rest, deps), command).toBe(1);
      expect(h.lines, command).toEqual([]);
      expect(errs, command).toEqual(['error: unknown key [nope]']);
    }
  });

  it('a refused config short-circuits before the runtime-exclude step', async () => {
    const h = harness({ config: refusedConfig() });
    expect(await dispatchCommand('run', [], h.deps)).toBe(1);
    expect(h.state.excludeCalls).toBe(0);
  });

  it('reports `config refused` when the load names no reason', async () => {
    const h = harness({ config: refusedConfigWithoutReason() });
    expect(await dispatchCommand('run', [], h.deps)).toBe(1);
    expect(h.lines).toEqual(['error: config refused']);
  });
});

describe('interactive project trust', () => {
  it('asks `kubic tui` on a TTY and loads with the accepted decision', async () => {
    const h = harness({ interactive: true, resolveTrust: async () => true });
    expect(await dispatchCommand('tui', [], h.deps)).toBe(0);
    expect(h.loadOptions).toEqual([{ projectTrusted: true }]);
    expect(h.calls.map((call) => call.key)).toEqual(['tui']);
  });

  it('a declined answer stops the lane through the refusal path', async () => {
    const reason =
      "project-local config refused pre-trust: /repo/.kubic/config.toml — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation";
    const h = harness({
      interactive: true,
      resolveTrust: async () => false,
      config: refusedConfig(reason),
    });
    expect(await dispatchCommand('tui', [], h.deps)).toBe(1);
    expect(h.loadOptions).toEqual([{ projectTrusted: false }]);
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual([`error: ${reason}`]);
  });

  it('asks the bare interactive invocation too', async () => {
    const h = harness({ interactive: true, resolveTrust: async () => true });
    expect(await dispatchCommand(undefined, [], h.deps)).toBe(0);
    expect(h.calls.map((call) => call.key)).toEqual(['tui']);
    expect(h.loadOptions).toEqual([{ projectTrusted: true }]);
  });

  it('never asks off a TTY or for a non-tui command', async () => {
    for (const [command, rest, interactive] of [
      ['tui', [], false],
      ['run', ['-p', 'hi'], true],
    ] as const) {
      let asks = 0;
      const h = harness({
        interactive,
        resolveTrust: async () => {
          asks += 1;
          return true;
        },
      });
      await dispatchCommand(command, rest, h.deps);
      expect(asks, command).toBe(0);
      expect(h.loadOptions, command).toEqual([undefined]);
    }
  });

  it('loads unmodified when the resolver has nothing to ask', async () => {
    let asks = 0;
    const h = harness({
      interactive: true,
      resolveTrust: async () => {
        asks += 1;
        return undefined;
      },
    });
    expect(await dispatchCommand('tui', [], h.deps)).toBe(0);
    expect(asks).toBe(1);
    expect(h.loadOptions).toEqual([undefined]);
  });

  it('never asks for a help request', async () => {
    let asks = 0;
    const h = harness({
      interactive: true,
      resolveTrust: async () => {
        asks += 1;
        return true;
      },
    });
    expect(await dispatchCommand('tui', ['--help'], h.deps)).toBe(0);
    expect(asks).toBe(0);
    expect(h.loadOptions).toEqual([undefined]);
  });

  it('fails closed when the resolver throws — a broken store must not boot', async () => {
    const h = harness({
      interactive: true,
      resolveTrust: async () => {
        throw new Error('trust store /h/.kubic/trust.json is not valid JSON');
      },
    });
    await expect(dispatchCommand('tui', [], h.deps)).rejects.toThrow(
      'trust store',
    );
    expect(h.calls).toEqual([]);
  });
});

describe('runtime exclude (moved order)', () => {
  it('ships the exclude rules for the state-creating modes', async () => {
    for (const command of ['run', 'tui']) {
      const h = harness();
      await dispatchCommand(command, [], h.deps);
      expect(h.state.excludeCalls, command).toBe(1);
    }
  });

  it('leaves other commands alone', async () => {
    for (const command of ['sessions', 'doctor', 'config', 'eval']) {
      const h = harness();
      await dispatchCommand(command, [], h.deps);
      expect(h.state.excludeCalls, command).toBe(0);
    }
  });

  it('a --help argv skips the exclude step', async () => {
    // `kubic run --help` is the command's generated help, not the root's:
    // commander answers it before the action, so the runtime-exclude write
    // (a repo mutation) must not happen for a help request.
    for (const command of ['run', 'tui']) {
      for (const flag of ['--help', '-h']) {
        const h = harness();
        expect(
          await dispatchCommand(command, [flag], h.deps),
          `${command} ${flag}`,
        ).toBe(0);
        expect(h.state.excludeCalls, `${command} ${flag}`).toBe(0);
        expect(h.calls, `${command} ${flag}`).toEqual([]);
        expect(h.lines.join('\n'), `${command} ${flag}`).toContain(
          `Usage: kubic ${command}`,
        );
      }
    }
  });

  it('ships exactly the runtime prefixes', async () => {
    const h = harness();
    await dispatchCommand('run', [], h.deps);
    expect(h.state.excludeEntries).toEqual([...RUNTIME_EXCLUDE_ENTRIES]);
  });
});

describe('prod wiring deps shapes (moved from main.ts)', () => {
  // The prod runners colour from the real stdout; NO_COLOR pins plain
  // diagnostics whatever terminal the test runner has.
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function capture() {
    const lines: string[] = [];
    const errs: string[] = [];
    return {
      lines,
      errs,
      io: {
        out: (line: string) => {
          lines.push(line);
        },
        debug: (line: string) => {
          errs.push(line);
        },
      },
    };
  }

  it('eval --task drives the live suite runner', async () => {
    // The built-in suite's fixture runs through the solo lane with the faux
    // provider, so --task produces a scored record instead of the old
    // "live suite execution is not available" refusal.
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    const workspace = mkdtempSync(join(tmpdir(), 'kubic-dispatch-eval-'));
    try {
      const cap = capture();
      const runners = createProdRunners(cap.io);
      const code = (
        await runners.eval(
          {
            task: 'do it',
            suite: 'swe-bench-mini',
            worktree: workspace,
            size: 'smoke',
          },
          loadedConfig(),
        )
      ).exitCode;
      expect(code).toBe(0);
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]).toMatch(
        /^eval ok: suite swe-bench-mini success=true /,
      );
      expect(cap.lines[0]).toMatch(/determinism=live/);
      expect(cap.errs).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('cost receives { loadRows, out } (an unknown session fails by name)', async () => {
    const cap = capture();
    const previousHome = process.env.HOME;
    process.env.HOME = FIXTURE;
    try {
      const code = (
        await createProdRunners(cap.io).cost(
          { session: 'no-such-session' },
          loadedConfig(),
        )
      ).exitCode;
      expect(code).toBe(1);
      expect(cap.lines).toEqual([]);
      expect(cap.errs).toEqual(['error: unknown session: no-such-session']);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('audit receives { loadRecords, loadSecrets, out } (zero rows is a clean report)', async () => {
    const cap = capture();
    // The ledger is the REPO's (`<repo>/.kubic/audit/`), resolved from the
    // cwd. Run from an empty scratch dir so the developer's
    // own ledger — or rows a mutation-run sandbox leaked into the enclosing
    // checkout — can never change the answer.
    const scratch = mkdtempSync(join(FIXTURE, 'audit-cwd-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(scratch);
    try {
      const code = (await createProdRunners(cap.io).audit({}, loadedConfig()))
        .exitCode;
      expect(code).toBe(0);
      expect(cap.lines).toEqual(['no audit records']);
    } finally {
      cwd.mockRestore();
    }
  });

  it('export receives { readFile, out } (a missing trajectory is a named failure)', async () => {
    const cap = capture();
    const code = (
      await createProdRunners(cap.io).export(
        { trajectory: '/definitely/missing.json', type: 'sft' },
        loadedConfig(),
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toHaveLength(1);
    expect(cap.errs[0]).toMatch(
      /^error: \[trajectory-unreadable\] cannot read trajectory "\/definitely\/missing\.json"/,
    );
  });
});
