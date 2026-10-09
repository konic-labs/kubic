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
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { RUNTIME_EXCLUDE_ENTRIES } from '@kubic/exec/runtime-exclude';
import { NO_PROJECT_TRUST } from '@kubic/host/config';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { CliConfigResult } from './config/load.js';
import { loadCliConfig } from './config/load.js';
import {
  type DispatchDeps,
  type DispatchRunners,
  dispatchCommand,
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

describe('runtime exclude rules', () => {
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

describe('prod wiring deps shapes', () => {
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
    // The built-in suite's fixture runs through the lane with the faux
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
    // own ledger can never change the answer.
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
