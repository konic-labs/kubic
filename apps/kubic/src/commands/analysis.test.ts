// The analysis command group over commander (cost, policy, audit, eval,
// benchmark, replay, export): argv syntax, generated help, the usage exit,
// option mapping, and the `--json` contract, driven through
// the real program (createKubicProgram + runKubicProgram) with the real
// handlers over faux deps — no network, no session store, no files beyond
// the in-memory ones below.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runBenchmarkCommand,
  runEvalCommand,
} from '../../../../packages/eval/src/cli.js';
import { runExportCommand } from '../../../../packages/eval/src/export-cli.js';
import { makeExport } from '../../../../packages/eval/src/rl/fixtures.js';
import { runCostCommand } from '../../../../packages/host/src/ops/cost/cost-cli.js';
import {
  AUDIT_FIELDS,
  EXAMPLE_AUDIT_RECORD,
} from '../../../../packages/host/src/policy/audit.js';
import { runAuditCommand } from '../../../../packages/host/src/policy/audit-cli.js';
import { resolveEffectivePolicy } from '../../../../packages/host/src/policy/enterprise.js';
import { runPolicyCommand } from '../../../../packages/host/src/policy/policy-cli.js';
import { runReplayCommand } from '../../../../packages/host/src/replay/replay.js';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import type { CliConfigResult } from '../config-runtime.js';
import { type AnalysisRunners, registerAnalysisCommands } from './analysis.js';

const CONFIG = {} as CliConfigResult;

const ANALYSIS = [
  'cost',
  'policy',
  'audit',
  'eval',
  'benchmark',
  'replay',
  'export',
] as const;

type AnalysisName = (typeof ANALYSIS)[number];

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  // The options each runner received, in call order.
  readonly calls: { name: string; options: unknown }[];
}

// Runs `kubic <argv>` over the analysis registrar. `real` wires the real
// handlers over faux deps (writing to the same captured channels);
// otherwise every runner is a recording fake answering 0.
async function kubic(argv: readonly string[], real = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Run['calls'] = [];
  const channels = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  const program = createKubicProgram(channels, {
    versionLine: 'kubic 0.0.0 (license: MIT)',
    rootHelp: 'usage: kubic <analysis>',
  });
  const handlers = realRunners(channels);
  const record =
    (name: AnalysisName) =>
    (options: unknown): number | Promise<number> => {
      calls.push({ name, options });
      if (!real) return 0;
      const runner = handlers[name] as (
        options: unknown,
        config: CliConfigResult,
      ) => number | Promise<number>;
      return runner(options, CONFIG);
    };
  const runners = Object.fromEntries(
    ANALYSIS.map((name) => [name, record(name)]),
  ) as unknown as DispatchRunners;
  let exitCode = 0;
  const ctx: CommandContext = {
    config: CONFIG,
    runners,
    rest: argv.slice(1),
    out: channels.out,
    err: channels.err,
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  registerAnalysisCommands(program, ctx);
  const code = await runKubicProgram(program, argv, channels, {
    code: () => exitCode,
  });
  return { code, out, err, calls };
}

const COST_ROWS = [
  {
    agentId: 'w-1',
    model: 'cheap/small',
    costUsd: 0.2,
    input: 100,
    output: 50,
  },
];

const FILES: Readonly<Record<string, string>> = {
  't.json': JSON.stringify(makeExport()),
};

function realRunners(channels: {
  out: (line: string) => void;
  err: (line: string) => void;
}): AnalysisRunners {
  const io = { out: channels.out, err: channels.err };
  const faux = {
    runSuite: async () => ({
      success: true,
      signals: {
        tests: 'unknown' as const,
        build: 'unknown' as const,
        lint: 'unknown' as const,
        typecheck: 'unknown' as const,
        completion: true,
        quality: 1,
        regressionFree: true,
        tokens: 1,
        costUsd: 0,
        latencyMs: 1,
        toolCalls: 0,
        toolCounts: {},
        escalations: 0,
      },
      usageRows: [
        { inputTokens: 1, outputTokens: 0, costUsd: 0, latencyMs: 1 },
      ],
    }),
    ensureCleanWorktree: () => true,
  };
  return {
    cost: (options) =>
      runCostCommand(options, { ...io, loadRows: () => COST_ROWS }),
    policy: (options) =>
      runPolicyCommand(options, {
        ...io,
        resolvePolicy: () =>
          resolveEffectivePolicy([
            { layer: 'session', policy: { tools: { allow: ['shell'] } } },
          ]).policy,
      }),
    audit: (options) =>
      runAuditCommand(options, {
        ...io,
        loadRecords: () => [EXAMPLE_AUDIT_RECORD],
      }),
    eval: (options) =>
      runEvalCommand(options, {
        ...io,
        ...faux,
        // §48 (issue #258): --trajectory takes a file path.
        readFile: () => JSON.stringify(makeExport()),
      }),
    benchmark: (options) => runBenchmarkCommand(options, { ...io, ...faux }),
    replay: (options) =>
      runReplayCommand(options, {
        ...io,
        run: async () => {
          throw new Error('recorded replay must not re-execute');
        },
      }),
    export: (options) =>
      runExportCommand(options, {
        ...io,
        readFile: (path) => {
          const text = FILES[path];
          if (text === undefined) throw new Error(`ENOENT: ${path}`);
          return text;
        },
      }),
  };
}

// replay reads its trajectory through the exec FileBridge (not an
// injected reader): one real fixture file, removed after the suite.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'kubic-analysis-'));
afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
const REPLAY_TRAJECTORY = join(FIXTURE_DIR, 't.json');
writeFileSync(REPLAY_TRAJECTORY, JSON.stringify(makeExport()));

const PROVENANCE_ARGV = [
  '--worktree',
  'wt',
  '--generation',
  '1',
  '--size',
  'smoke',
];

// A minimal valid invocation per command (required options satisfied).
const VALID: Readonly<Record<AnalysisName, readonly string[]>> = {
  cost: [],
  policy: ['--tool', 'shell'],
  audit: [],
  eval: ['--suite', 'swe-bench-mini', '--task', 'fix', ...PROVENANCE_ARGV],
  benchmark: ['--suite', 'swe-bench-mini', ...PROVENANCE_ARGV],
  replay: [REPLAY_TRAJECTORY],
  export: ['--trajectory', 't.json'],
};

describe('analysis commands: generated help', () => {
  for (const name of ANALYSIS) {
    it(`kubic ${name} --help / -h prints generated help on stdout, exit 0`, async () => {
      for (const flag of ['--help', '-h']) {
        const run = await kubic([name, flag]);
        expect(run.code, flag).toBe(0);
        expect(run.err, flag).toEqual([]);
        expect(run.calls, flag).toEqual([]);
        const text = run.out.join('\n');
        expect(text).toMatch(new RegExp(`^Usage: kubic ${name} `));
        expect(text).toContain('--help');
        expect(text).toContain('Examples:');
        expect(text).toContain(`$ kubic ${name}`);
      }
    });
  }

  it('help lists every declared option with its argument', async () => {
    const expected: Record<AnalysisName, readonly string[]> = {
      cost: ['--session <id>', '--json'],
      policy: ['--tool <name>', '--json'],
      audit: ['--posture <name>', '--result <result>', '--json'],
      eval: [
        '--suite <id>',
        '--task <prompt>',
        '--trajectory <file>',
        '--model <id>',
        '--worktree <path>',
        '--generation <n>',
        '--size <size>',
        '--workspace <kind>',
        '--thinking <level>',
        '--json',
      ],
      benchmark: ['--suite <id>', '--generation <n>', '--json'],
      replay: [
        '[trajectory]',
        '--tier <tier>',
        '--model <provider/id>',
        '--lockfile <path>',
        '--role-config <path>',
        '--worktree <path>',
        '--diff-against <other.json>',
        '--json',
      ],
      export: [
        '--trajectory <file>',
        '--type <type>',
        '--against <other.json>',
        '--dataset <dir|glob>',
        '--out <file.jsonl>',
        '--json',
      ],
    };
    for (const name of ANALYSIS) {
      const text = (await kubic([name, '--help'])).out.join('\n');
      for (const option of expected[name]) {
        expect(text, `${name} ${option}`).toContain(option);
      }
    }
  });

  it('shows the eval model default', async () => {
    // #256: eval's --model has no commander default (--trajectory reads the
    // export); the --task default is documented in the help text instead.
    const evalHelp = (await kubic(['eval', '--help'])).out.join('\n');
    expect(evalHelp).toContain('--task default faux/echo');
    expect(evalHelp).not.toContain('(default: "faux/echo")');
    expect((await kubic(['benchmark', '--help'])).out.join('\n')).toContain(
      '(default: "faux/echo")',
    );
  });
});

describe('analysis commands: usage errors exit 2', () => {
  for (const name of ANALYSIS) {
    it(`kubic ${name} --bogus: one stderr line, exit 2, runner never reached`, async () => {
      const run = await kubic([name, ...VALID[name], '--bogus']);
      expect(run.code).toBe(2);
      expect(run.out).toEqual([]);
      expect(run.err).toEqual(["error: unknown option '--bogus'"]);
      expect(run.calls).toEqual([]);
    });
  }

  it('a value option without its value exits 2', async () => {
    for (const argv of [
      ['cost', '--session'],
      ['audit', '--posture'],
      ['policy', '--tool'],
      ['replay', 't.json', '--model'],
      ['export', '--trajectory'],
    ]) {
      const run = await kubic(argv);
      expect(run.code, argv.join(' ')).toBe(2);
      expect(run.err[0], argv.join(' ')).toMatch(
        /^error: option '.+' argument missing$/,
      );
      expect(run.calls).toEqual([]);
    }
  });

  it('a missing required option exits 2 naming it', async () => {
    const cases: [readonly string[], string][] = [
      [['policy'], '--tool <name>'],
      [['eval', '--task', 'x', '--generation', '1'], '--suite <id>'],
      [['benchmark'], '--generation <n>'],
    ];
    for (const [argv, option] of cases) {
      const run = await kubic(argv);
      expect(run.code, argv.join(' ')).toBe(2);
      expect(run.err, argv.join(' ')).toEqual([
        `error: required option '${option}' not specified`,
      ]);
      expect(run.calls).toEqual([]);
    }
  });

  it('export and replay take --session <id> as the trajectory source (#383)', async () => {
    const exported = await kubic([
      'export',
      '--session',
      'abc',
      '--type',
      'sft',
    ]);
    expect(exported.err).toEqual([]);
    expect(exported.calls).toEqual([
      { name: 'export', options: { session: 'abc', type: 'sft' } },
    ]);
    const replayed = await kubic(['replay', '--session', 'abc']);
    expect(replayed.err).toEqual([]);
    expect(replayed.calls).toEqual([
      { name: 'replay', options: { session: 'abc' } },
    ]);
    // Neither source: the handler (not commander) names the missing one.
    const neither = await kubic(['export']);
    expect(neither.calls).toEqual([{ name: 'export', options: {} }]);
  });

  it('eval --trajectory needs no provenance flags at the commander layer (#256)', async () => {
    const run = await kubic([
      'eval',
      '--suite',
      's',
      '--trajectory',
      't.json',
      '--size',
      'smoke',
    ]);
    expect(run.err).toEqual([]);
    expect(run.calls).toHaveLength(1);
  });

  it('a stray operand exits 2 (replay takes exactly one trajectory)', async () => {
    for (const argv of [
      ['cost', 'extra'],
      ['replay', 't.json', 'extra'],
    ]) {
      const run = await kubic(argv);
      expect(run.code, argv.join(' ')).toBe(2);
      expect(run.err[0], argv.join(' ')).toMatch(/^error: too many arguments/);
      expect(run.calls).toEqual([]);
    }
  });
});

describe('analysis commands: parsed options reach the runners', () => {
  it('maps flags to camel-cased option values, --flag=value included', async () => {
    const cases: [readonly string[], unknown][] = [
      [['cost', '--session=s-1', '--json'], { session: 's-1', json: true }],
      // Issue #250: the project scope and grouping flags.
      [['cost', '--all', '--by=project'], { all: true, by: 'project' }],
      [
        ['audit', '--posture', 'approvals', '--result', 'ok'],
        { posture: 'approvals', result: 'ok' },
      ],
      [
        [
          'replay',
          't.json',
          '--tier',
          'live',
          '--role-config',
          'r.md',
          '--diff-against',
          'o.json',
        ],
        {
          trajectory: 't.json',
          tier: 'live',
          roleConfig: 'r.md',
          diffAgainst: 'o.json',
        },
      ],
      [
        [
          'export',
          '--trajectory',
          'a.json',
          '--type',
          'dpo',
          '--against',
          'b.json',
        ],
        { trajectory: 'a.json', type: 'dpo', against: 'b.json' },
      ],
      [
        ['benchmark', '--generation', '2', '--workspace', 'worktree'],
        { generation: '2', workspace: 'worktree', model: 'faux/echo' },
      ],
    ];
    for (const [argv, options] of cases) {
      const run = await kubic(argv);
      expect(run.code, argv.join(' ')).toBe(0);
      expect(run.calls, argv.join(' ')).toEqual([{ name: argv[0], options }]);
    }
  });

  it('`--` ends the options: a dash-leading trajectory reaches replay', async () => {
    const run = await kubic(['replay', '--json', '--', '-odd.json']);
    expect(run.calls).toEqual([
      { name: 'replay', options: { json: true, trajectory: '-odd.json' } },
    ]);
  });

  it('a runner exit code is the process exit code', async () => {
    const run = await kubic(['export', '--trajectory', 'missing.json'], true);
    expect(run.code).toBe(2);
  });
});

describe('analysis commands: happy paths over the real handlers', () => {
  it('cost prints a table and the task total', async () => {
    const run = await kubic(['cost'], true);
    expect(run.code).toBe(0);
    // Issue #250 (§39): group + role + split counters at sub-cent precision.
    expect(run.out[0]).toMatch(
      /^AGENT +ROLE +MODEL +IN +OUT +CACHE-R +CACHE-W +COST$/m,
    );
    expect(run.out[1]).toBe('task total $0.2000 (1 agents)');
    expect(run.err).toEqual([]);
  });

  it('policy prints the decision', async () => {
    const run = await kubic(['policy', '--tool', 'shell'], true);
    expect(run.out).toEqual(['allow shell (installed)']);
  });

  it('audit prints the record table', async () => {
    const run = await kubic(['audit'], true);
    expect(run.code).toBe(0);
    expect(run.out[0]).toMatch(/^WHEN +POSTURE +RESULT/);
  });

  it('eval prints the record line', async () => {
    const run = await kubic(['eval', ...VALID.eval], true);
    expect(run.code).toBe(0);
    expect(run.out[0]).toMatch(/^eval ok: suite swe-bench-mini /);
  });

  it('benchmark prints the matrix table and the verdict', async () => {
    const run = await kubic(['benchmark', ...VALID.benchmark], true);
    expect(run.code).toBe(0);
    expect(run.out.at(-1)).toMatch(/^benchmark ok: 1\/1 suites passed/);
  });

  it('replay describes the recorded trajectory', async () => {
    const run = await kubic(['replay', REPLAY_TRAJECTORY], true);
    expect(run.code).toBe(0);
    expect(run.out.join('\n')).toMatch(/tier: recorded/);
  });

  it('export describes the trajectory', async () => {
    const run = await kubic(['export', '--trajectory', 't.json'], true);
    expect(run.code).toBe(0);
    expect(run.out[0]).toMatch(/^schema: /);
  });

  it('a semantic refusal is one stderr line and exit 2', async () => {
    const run = await kubic(['audit', '--result', 'turbo'], true);
    expect(run.code).toBe(2);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      'error: unknown result "turbo" (want ok|deny|error)',
    ]);
  });
});

describe('analysis commands: --json prints exactly one JSON document', () => {
  const shapes: Record<AnalysisName, readonly string[]> = {
    cost: ['agents', 'taskTotal'],
    policy: ['decision', 'source', 'tool'],
    audit: [],
    eval: ['exitCode', 'ok', 'record'],
    benchmark: ['exitCode', 'ok', 'results'],
    replay: [
      'changed',
      'exitCode',
      'invocation',
      'ok',
      'result',
      'tier',
      'trajectory',
    ],
    export: ['exitCode', 'ok', 'trajectory'],
  };
  for (const name of ANALYSIS) {
    it(`kubic ${name} --json`, async () => {
      const run = await kubic([name, ...VALID[name], '--json'], true);
      expect(run.code).toBe(0);
      expect(run.err).toEqual([]);
      expect(run.out).toHaveLength(1);
      const document: unknown = JSON.parse(run.out[0] ?? '');
      if (name === 'audit') {
        expect(Array.isArray(document)).toBe(true);
        const [record] = document as Record<string, unknown>[];
        expect(Object.keys(record ?? {}).sort()).toEqual(
          [...AUDIT_FIELDS].sort(),
        );
        return;
      }
      expect(Object.keys(document as object).sort()).toEqual(shapes[name]);
    });
  }

  it('an error under --json keeps stdout pure: the envelope, or nothing', async () => {
    const missing = await kubic(
      ['export', '--trajectory', 'missing.json', '--json'],
      true,
    );
    expect(missing.code).toBe(2);
    expect(missing.err).toEqual([]);
    expect(JSON.parse(missing.out.join('\n'))).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: 'trajectory-unreadable' },
    });
    const usage = await kubic(['audit', '--result', 'warp', '--json'], true);
    expect(usage.code).toBe(2);
    expect(usage.out).toEqual([]);
    expect(usage.err).toHaveLength(1);
  });
});
