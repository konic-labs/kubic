// Dispatch wiring suite (issue #135): the composition root's front door —
// which command routes to which runner, the config-refusal matrix, the §78
// exit codes, and the front-door special cases — over injected
// runners. Faux everything: no real lanes, no network, and no fs beyond the
// one fixture dir this file creates.
//
// The `prod wiring deps shapes` block drives the REAL production runners
// (./prod-runners.js) over hermetic argv and fixtures on purpose: it pins
// the documented deps shapes the root wires (clean {env,out,err}, cost
// {loadRows,out}, audit {loadRecords,loadSecrets,out}, export {readFile,out})
// and the eval runSuite refusal message, verbatim.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { RUNTIME_EXCLUDE_ENTRIES } from '../../../packages/exec/src/runtime-exclude.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import {
  type CliConfigResult,
  loadCliConfig,
  runtimeExcludeEntriesFor,
} from './config-runtime.js';
import {
  type DispatchDeps,
  type DispatchRunners,
  dispatchCommand,
  ROOT_USAGE,
} from './dispatch.js';
import { createProdRunners } from './prod-runners.js';

type RunnerKey = keyof DispatchRunners;

// The runner roster: one entry per command seam the root wires inline
// (22 command names, 19 runners — the four journal commands share one).
const RUNNER_KEYS: readonly RunnerKey[] = [
  'sessions',
  'git',
  'journal',
  'models',
  'run',
  'tui',
  'doctor',
  'orchestrate',
  'clean',
  'cost',
  'perf',
  'policy',
  'config',
  'trust',
  'audit',
  'workers',
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
  ['diff', ['--json'], 'journal'],
  ['undo', ['--step'], 'journal'],
  ['log', [], 'journal'],
  ['status', [], 'journal'],
  ['models', ['--json'], 'models'],
  ['run', ['-p', 'hi'], 'run'],
  ['tui', [], 'tui'],
  ['doctor', [], 'doctor'],
  ['orchestrate', [], 'orchestrate'],
  ['clean', ['--dry-run'], 'clean'],
  ['cost', ['--json'], 'cost'],
  ['perf', ['--budget', 'spawn', '--samples', '1'], 'perf'],
  ['policy', ['--tool', 'shell'], 'policy'],
  ['config', ['--json'], 'config'],
  ['trust', [], 'trust'],
  ['audit', [], 'audit'],
  ['workers', ['--json'], 'workers'],
  [
    'eval',
    ['--suite', 'swe-bench-mini', '--task', 'p', '--generation', '1'],
    'eval',
  ],
  ['benchmark', ['--generation', '1'], 'benchmark'],
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
  doctor: { skip: [] },
  config: { json: true },
  trust: {},
  orchestrate: {},
  clean: { dryRun: true },
  workers: { json: true },
  git: { command: 'status' },
  diff: { command: 'diff', json: true },
  undo: { command: 'undo', step: true },
  log: { command: 'log' },
  status: { command: 'status' },
  cost: { json: true },
  perf: { budget: 'spawn', samples: '1' },
  policy: { tool: 'shell' },
  audit: {},
  // #256: no commander model default on eval — the handler applies it on
  // the --task path; --trajectory reads the model from the export.
  eval: {
    suite: 'swe-bench-mini',
    task: 'p',
    generation: '1',
  },
  benchmark: { generation: '1', model: 'faux/faux' },
  replay: { trajectory: 't.json', tier: 'recorded' },
  export: { trajectory: 'trajectory.json' },
};

// Every runner receives the options commander parsed.
type AnyRunner = (
  input: unknown,
  config: CliConfigResult,
) => number | Promise<number>;

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
  // The options each `loadConfig` call received (issue #228: the accepted
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
      return override === undefined ? 0 : override(rest, config);
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

describe('dispatch routing (issue #135)', () => {
  it('pins the roster: 23 commands, 20 runners, every runner exercised', () => {
    expect(ROUTES).toHaveLength(23);
    expect(RUNNER_KEYS).toHaveLength(20);
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
    const h = harness({ runners: { sessions: () => 42 } });
    expect(await dispatchCommand('sessions', ['list'], h.deps)).toBe(42);
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
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });
});

describe('front door (issue #128 behavior, moved)', () => {
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
      expect(h.lines, flag).toEqual([ROOT_USAGE]);
      expect(h.calls, flag).toEqual([]);
    }
  });

  it('the bare invocation prints the usage and exits 1 (POSIX posture)', async () => {
    const h = harness();
    expect(await dispatchCommand(undefined, [], h.deps)).toBe(1);
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });

  it('the bare invocation on an interactive terminal opens the TUI (§78/§80)', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand(undefined, [], deps)).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([['tui', {}]]);
    // Same boot as `kubic tui`: the runtime ignore rules ship first.
    expect(h.state.excludeCalls).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it('bare `kubic --dangerously-skip-approvals` on a TTY is `kubic tui --dangerously-skip-approvals` (issue #308)', async () => {
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

  it('bare `kubic --dangerously-skip-approvals` off a TTY keeps usage + exit 1 (issue #308)', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => false };
    expect(
      await dispatchCommand('--dangerously-skip-approvals', [], deps),
    ).toBe(1);
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });

  // Issue #327: bare `kubic --orchestrator` on a TTY IS `kubic tui
  // --orchestrator` — the opt-in interactive orchestrator entry. Off a TTY
  // it keeps the bare usage + exit 1 posture like the other bare flags.
  it('bare `kubic --orchestrator` on a TTY is `kubic tui --orchestrator` (issue #327)', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand('--orchestrator', [], deps)).toBe(0);
    expect(h.calls.map((call) => [call.key, call.rest])).toEqual([
      ['tui', { orchestrator: true }],
    ]);
    // Same boot as `kubic tui`: the runtime ignore rules ship first.
    expect(h.state.excludeCalls).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it('bare `kubic --orchestrator` off a TTY keeps usage + exit 1 (issue #327)', async () => {
    const h = harness();
    const deps = { ...h.deps, isInteractive: () => false };
    expect(await dispatchCommand('--orchestrator', [], deps)).toBe(1);
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });

  // Issue #295: bare `kubic --model p/id` on a TTY is `kubic tui --model`.
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
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });

  it('a refused config stops the bare interactive TUI like `kubic tui`', async () => {
    const h = harness({ config: refusedConfig() });
    const deps = { ...h.deps, isInteractive: () => true };
    expect(await dispatchCommand(undefined, [], deps)).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('throws from the gated crash probe (contract seam, issue #128)', async () => {
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
    expect(h.lines).toEqual([ROOT_USAGE]);
    expect(h.calls).toEqual([]);
  });

  it('an unknown root option or `help` is a usage error (usage, exit 2)', async () => {
    for (const command of ['--bogus', '-x', 'help']) {
      const h = harness();
      expect(await dispatchCommand(command, [], h.deps), command).toBe(2);
      expect(h.lines, command).toEqual([ROOT_USAGE]);
      expect(h.calls, command).toEqual([]);
    }
  });

  it('root options after the command reach the command (positional options)', async () => {
    // `--help` after a command is that command's generated help, never the
    // root listing; `-V` after it is the command's (unknown) option, never
    // the root version.
    const help = harness();
    expect(await dispatchCommand('doctor', ['--help'], help.deps)).toBe(0);
    expect(help.calls).toEqual([]);
    expect(help.lines.join('\n')).toContain('Usage: kubic doctor');
    expect(help.lines).not.toContain(ROOT_USAGE);
    const version = harness();
    expect(await dispatchCommand('doctor', ['-V'], version.deps)).toBe(2);
    expect(version.calls).toEqual([]);
    expect(version.lines.join('\n')).toContain("unknown option '-V'");
  });
});

describe('config refusal (issue #90 policy, moved)', () => {
  const CONSUMING = ['run', 'orchestrate', 'tui', 'replay'];
  const REPORTING = ['config', 'doctor', 'trust'];

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
    expect(others).toHaveLength(16);
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

  it('prints the command’s failure envelope on stdout under --json (issue #244)', async () => {
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
        command: 'orchestrate',
        rest: ['-p', 'hi', '--json'],
        check: (envelope) => {
          expect(envelope.status).toBe('failed');
          expect(envelope.sessionId).toBe('unassigned');
          expect(envelope.workers).toEqual([]);
          expect(envelope.error).toEqual({
            kind: 'failed',
            message: 'unknown key [nope]',
            code: 'config_refused',
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
      ['orchestrate', ['-p', 'hi']],
      ['replay', ['t.json']],
      ['tui', []],
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

describe('interactive project trust (issue #228)', () => {
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

describe('runtime exclude (issue #91, moved order)', () => {
  it('ships the exclude rules for the state-creating modes', async () => {
    for (const command of ['run', 'orchestrate', 'tui']) {
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

  it('runs the exclude step before the runner, even for a --help argv', async () => {
    // `kubic run --help` is the command's generated help, not the root's:
    // the root's help check is argv[0]-only, and the moved order ships the
    // exclude rules before commander answers (the runner is never reached).
    const h = harness();
    expect(await dispatchCommand('run', ['--help'], h.deps)).toBe(0);
    expect(h.state.excludeCalls).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.lines.join('\n')).toContain('Usage: kubic run');
  });

  it('ships the configured worktree parent with the runtime prefixes (issue #133)', async () => {
    // Under FIXTURE so the afterAll cleanup removes it too.
    const dir = mkdtempSync(join(FIXTURE, 'root-'));
    mkdirSync(join(dir, '.kubic'), { recursive: true });
    writeFileSync(
      join(dir, '.kubic', 'config.toml'),
      '[orchestrator]\nroot = ".kubic-custom/wt"\n',
    );
    const config = loadCliConfig({
      cwd: dir,
      home: dir,
      env: {},
      projectTrusted: true,
    });
    expect(config.runtime?.orchestrator.root).toBe('.kubic-custom/wt');

    const h = harness({ config });
    expect(await dispatchCommand('orchestrate', [], h.deps)).toBe(0);
    expect(h.state.excludeEntries).toEqual([
      ...RUNTIME_EXCLUDE_ENTRIES,
      '/.kubic-custom/wt/',
    ]);

    // The unconfigured load ships exactly the shipped prefixes — no
    // invented entry, no dropped one.
    const bare = harness();
    await dispatchCommand('run', [], bare.deps);
    expect(bare.state.excludeEntries).toEqual([...RUNTIME_EXCLUDE_ENTRIES]);
  });

  it('refuses a hostile root at the entry derivation, before any write (issue #133 review)', () => {
    // Defense in depth: the config load refuses control characters by name;
    // if one ever reached this seam, the derivation refuses to hand the
    // entry to the writer — no hostile entry can be written.
    expect(() => runtimeExcludeEntriesFor('x\n*.log')).toThrow(
      /control characters/,
    );
    expect(() => runtimeExcludeEntriesFor('wt\u001b[31mX')).toThrow(
      /control characters/,
    );
    // The safe path is unchanged: the shipped five, plus the configured root,
    // anchored to the repo root (issue #133 fix-cycle-3).
    expect(runtimeExcludeEntriesFor('.kubic-custom/wt')).toEqual([
      ...RUNTIME_EXCLUDE_ENTRIES,
      '/.kubic-custom/wt/',
    ]);
  });

  it('refuses metacharacter roots and committed-half collisions at the derivation (issue #133 re-review)', () => {
    // Defense in depth over the one derivation every consumer shares: a
    // root whose `<root>/` entry would act as a gitignore pattern other
    // than the literal path it names is refused here too — never repaired
    // into a different rule.
    for (const root of [
      '*',
      '**',
      '.kubic*',
      '.kubi[c]',
      '.kubi?',
      '#x',
      'x\\',
    ]) {
      expect(() => runtimeExcludeEntriesFor(root), root).toThrow(
        /gitignore metacharacters/,
      );
    }
    // The committed-half collision is re-checked here as well: the config
    // load refuses `.kubic` / `.kubic/roles` first, but the derivation must
    // never hand the writer an entry that would ignore D35's committed
    // files even when a programmatic caller bypassed the load.
    for (const root of [
      '.kubic',
      '.kubic/roles',
      '.kubic//roles',
      '.kubic/./roles',
    ]) {
      expect(() => runtimeExcludeEntriesFor(root), root).toThrow(
        /committed config half/,
      );
    }
  });

  it('anchors the derived entry to the repo root (issue #133 fix-cycle-3)', () => {
    // A pattern whose only slash is trailing is NOT anchored: `worktrees/`
    // matches a directory of that name at any depth, so `deep/worktrees/y.txt`
    // and `src/worktrees/z.txt` would be hidden and skipped by `git add -A`.
    // The derived entry carries the leading slash that anchors it; the
    // shipped five already contain a middle slash, so they stay byte-identical.
    const entries = runtimeExcludeEntriesFor('worktrees');
    expect(entries.slice(0, -1)).toEqual([...RUNTIME_EXCLUDE_ENTRIES]);
    expect(entries[entries.length - 1]).toBe('/worktrees/');
    // Multi-segment roots are anchored the same way (a no-op for git, which
    // anchors any pattern with a middle slash) — one entry shape, every root.
    expect(runtimeExcludeEntriesFor('.kubic-custom/wt')).toEqual([
      ...RUNTIME_EXCLUDE_ENTRIES,
      '/.kubic-custom/wt/',
    ]);
    // The shipped default keeps the shipped list exactly: `.kubic/wt/` is
    // already anchored by its middle slash, and the repo's own gate pins
    // those five entries verbatim.
    expect(runtimeExcludeEntriesFor('.kubic/wt')).toEqual([
      ...RUNTIME_EXCLUDE_ENTRIES,
    ]);
    expect(runtimeExcludeEntriesFor(undefined)).toEqual([
      ...RUNTIME_EXCLUDE_ENTRIES,
    ]);
  });

  it('re-checks the path shape at the entry derivation (issue #133 fix-cycle-3)', () => {
    // The config load refuses these first; the derivation re-checks for
    // programmatic callers that never pass through the load, with the load's
    // own message. An empty value, an absolute path, a `..` segment and a
    // trailing '/' can never become a repo-root entry.
    for (const root of ['', '   ', '/abs', '//', 'x/', 'a/..', '../x', '..']) {
      expect(
        () => runtimeExcludeEntriesFor(root),
        JSON.stringify(root),
      ).toThrow(/'orchestrator': 'root' must be a workspace-relative path/);
    }
  });

  it('re-checks the committed half case-insensitively at the derivation (issue #133 fix-cycle-3)', () => {
    // git case-folds ignore patterns on a case-insensitive filesystem, so a
    // case variant of `.kubic` / `.kubic/roles` hides the committed half
    // exactly like the exact spelling — refused here with the same name.
    for (const root of ['.KUBIC', '.Kubic', '.KUBIC/roles', '.kubic/ROLES']) {
      expect(() => runtimeExcludeEntriesFor(root), root).toThrow(
        /committed config half/,
      );
    }
  });

  it('re-checks the no-op roots at the derivation (issue #133 fix-cycle-3)', () => {
    // '.' / './…' / '…/.' names the directory it sits in: the derived entry
    // would match nothing and the worktree set would stay unignored.
    for (const root of ['.', './.', './worktrees', 'foo/.']) {
      expect(() => runtimeExcludeEntriesFor(root), root).toThrow(
        /must not name the workspace or carry a '\.' segment/,
      );
    }
  });
});

describe('workers usage exit (issue #77, §78)', () => {
  it('commander refuses an unknown flag with exit 2 before the runner', async () => {
    const h = harness();
    expect(await dispatchCommand('workers', ['--nope'], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('passes every runner code through unchanged (no remap left)', async () => {
    for (const code of [0, 1, 3, 6]) {
      const h = harness({ runners: { workers: async () => code } });
      expect(await dispatchCommand('workers', [], h.deps), `code ${code}`).toBe(
        code,
      );
    }
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

  it('eval --task surfaces the runSuite refusal verbatim', async () => {
    const cap = capture();
    const runners = createProdRunners(cap.io);
    const code = await runners.eval(
      {
        task: 'do it',
        suite: 'swe-bench-mini',
        worktree: '/tmp/w',
        generation: '1',
        tier: 'smoke',
      },
      loadedConfig(),
    );
    expect(code).toBe(1);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: live suite execution is not available in this binary: score a recorded trajectory with --trajectory (see packages/eval/COMMUNITY.md)',
    ]);
  });

  it('clean receives { env, out, err } (an unknown session fails by name on stderr)', async () => {
    // Read-only: a dry run scoped to a session this checkout never ran
    // resolves the repo, finds no retained set, and removes nothing.
    const cap = capture();
    const code = await createProdRunners(cap.io).clean(
      { sessionId: 'no-such-session-dispatch-test', dryRun: true },
      loadedConfig(),
    );
    expect(code).toBe(1);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toHaveLength(1);
    expect(cap.errs[0]).toMatch(
      /^error: no retained set for session 'no-such-session-dispatch-test'/,
    );
  });

  it('cost receives { loadRows, out } (an unknown session fails by name)', async () => {
    const cap = capture();
    const previousHome = process.env.HOME;
    process.env.HOME = FIXTURE;
    try {
      const code = await createProdRunners(cap.io).cost(
        { session: 'no-such-session' },
        loadedConfig(),
      );
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
    // The ledger is the REPO's (`<repo>/.kubic/orchestrator/approvals/`),
    // resolved from the cwd. Run from an empty scratch dir so the developer's
    // own ledger — or rows a mutation-run sandbox leaked into the enclosing
    // checkout — can never change the answer.
    const scratch = mkdtempSync(join(FIXTURE, 'audit-cwd-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(scratch);
    try {
      const code = await createProdRunners(cap.io).audit({}, loadedConfig());
      expect(code).toBe(0);
      expect(cap.lines).toEqual(['no audit records']);
    } finally {
      cwd.mockRestore();
    }
  });

  it('export receives { readFile, out } (a missing trajectory is a named failure)', async () => {
    const cap = capture();
    const code = await createProdRunners(cap.io).export(
      { trajectory: '/definitely/missing.json', type: 'sft' },
      loadedConfig(),
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toHaveLength(1);
    expect(cap.errs[0]).toMatch(
      /^error: \[trajectory-unreadable\] cannot read trajectory "\/definitely\/missing\.json"/,
    );
  });
});

describe('workers runner reads the durable record (issue #132)', () => {
  it('constructs no WorkerRegistry: the CLI lists workersListFromRepo directly', () => {
    // Issue #94's finding, finished: a fresh CLI process's WorkerRegistry is
    // always empty, so a registry branch in the workers runner is
    // structurally dead — every invocation paid the fallthrough. The rows
    // come from the durable record (<repo>/.kubic/orchestrator/workers.json);
    // the registry stays the orchestrator run's own in-process view
    // (packages/worker/src/lifecycle/registry.ts). Structural pin, per the
    // issue's acceptance: main.ts no longer constructs a WorkerRegistry and
    // the seam lists from the record directly.
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const seam = readFileSync(join(srcDir, 'prod-runners.ts'), 'utf8');
    const main = readFileSync(join(srcDir, 'main.ts'), 'utf8');
    // Non-vacuity: both reads found the real sources, not empty files.
    expect(seam.length).toBeGreaterThan(1_000);
    expect(main.length).toBeGreaterThan(1_000);
    for (const [name, source] of [
      ['prod-runners.ts', seam],
      ['main.ts', main],
    ] as const) {
      expect(source, `${name} must not construct a WorkerRegistry`).not.toMatch(
        /new WorkerRegistry\b/,
      );
      expect(
        source,
        `${name} must not import the lifecycle registry`,
      ).not.toMatch(/lifecycle\/registry\.js/);
    }
    // The one list source the runner reads: the durable record, directly.
    expect(seam).toMatch(/workersListFromRepo\(process\.cwd\(\)\)/);
  });
});
