// Analysis surfaces: cost, policy, audit, eval, benchmark, replay,
// export. Registered on the root program by ../dispatch.ts; this module is
// the one place their commander definitions live.
//
// commander owns argv syntax for these commands — options and operands,
// `--flag=value`, `--`, generated `--help`, and the usage errors (unknown
// option, missing value, a missing required option, excess operands: exit
// 2 with one `error: …` line on stderr, core/cli/exit-codes.ts). Values
// reach the handlers as raw strings: the vocabularies (audit modes, replay
// tiers, dataset types) and the cross-flag rules stay each
// handler's semantics, so a secret-shaped value is redacted before it is
// echoed and replay/export/eval keep their `--json` error envelopes.

import {
  EVAL_DEFAULT_MODEL,
  type EvalOptions,
} from '../../../../packages/eval/src/cli.js';
import {
  DATASET_TYPES,
  type ExportCommandOptions,
} from '../../../../packages/eval/src/export-cli.js';
import type { CostOptions } from '../../../../packages/host/src/ops/cost/cost-cli.js';
import type { AuditOptions } from '../../../../packages/host/src/policy/audit-cli.js';
import type { PolicyOptions } from '../../../../packages/host/src/policy/policy-cli.js';
import type { ReplayCommandOptions } from '../../../../packages/host/src/replay/replay.js';
import type { CommandRegistrar, KubicProgram } from '../cli/context.js';
import type { CliConfigResult } from '../config-runtime.js';

// One analysis runner: commander's parsed options plus the process-wide
// config load in, the exit code out (production wiring: ../prod-runners.ts).
export type AnalysisRunner<Options> = (
  options: Options,
  config: CliConfigResult,
) => number | Promise<number>;

export interface AnalysisRunners {
  readonly cost: AnalysisRunner<CostOptions>;
  readonly policy: AnalysisRunner<PolicyOptions>;
  readonly audit: AnalysisRunner<AuditOptions>;
  readonly eval: AnalysisRunner<EvalOptions>;
  readonly benchmark: AnalysisRunner<EvalOptions>;
  readonly replay: AnalysisRunner<ReplayCommandOptions & SessionOption>;
  readonly export: AnalysisRunner<ExportCommandOptions & SessionOption>;
}

// `--session <id>` (issue #383): read the session's own §46 trajectory
// (<sessions-root>/<id>/trajectory.json) instead of naming the file. The
// prod runner resolves it (./run-trajectory.ts resolveSessionTrajectory).
export interface SessionOption {
  readonly session?: string;
}

const SESSION_TRAJECTORY_HELP =
  "read that run's trajectory: <sessions-root>/<id>/trajectory.json";

const JSON_HELP = 'print one JSON document on stdout';
const ENVELOPE_HELP =
  'print one JSON envelope on stdout (runtime failures included; a usage error stays on stderr)';
// eval and benchmark share the §48 provenance flags.
const MODEL_HELP = 'provider/id of the run';
const WORKTREE_HELP = 'where the run executed (provenance)';
const GENERATION_HELP = 'worker generation that ran (provenance, integer)';
const SIZE_HELP =
  'record size: smoke|standard|extended (the §47.1 determinism tier is derived)';
const WORKSPACE_HELP =
  'inline|worktree (default inline; worktree needs a clean --worktree)';
const THINKING_HELP = 'thinking level, recorded verbatim';
// eval --trajectory reads model/thinking/worktree/generation from the
// export (#256): the flag only cross-checks it.
const FROM_EXPORT = '; --trajectory reads it from the export';

function examples(lines: readonly string[]): string {
  return `\nExamples:\n${lines.map((line) => `  $ ${line}`).join('\n')}`;
}

function command(
  program: KubicProgram,
  name: string,
  description: string,
  usageExamples: readonly string[],
) {
  return program
    .command(name)
    .description(description)
    .addHelpText('after', examples(usageExamples));
}

export const registerAnalysisCommands: CommandRegistrar = (program, ctx) => {
  const { config, runners } = ctx;
  const done = (code: number): void => {
    ctx.setExitCode(code);
  };

  command(
    program,
    'cost',
    'report per-agent token and dollar cost over stored sessions',
    ['kubic cost', 'kubic cost --session 3f2a --json'],
  )
    .option('--session <id>', 'read only this session ([A-Za-z0-9_-])')
    .option(
      '--all',
      'include sessions from every project (default: this project only)',
    )
    .option(
      '--by <level>',
      'group rows: request|agent|session|project (default agent)',
    )
    .option('--json', JSON_HELP)
    .action(async (options) => done(await runners.cost(options, config)));

  command(
    program,
    'policy',
    'report the installed tool policy decision for one tool (a routing offer, never enforcement)',
    ['kubic policy --tool shell', 'kubic policy --tool network_fetch --json'],
  )
    .requiredOption('--tool <name>', 'the tool to query')
    .option('--json', JSON_HELP)
    .action(async (options) => done(await runners.policy(options, config)));

  command(
    program,
    'audit',
    "query the repo's approval audit ledger (redacted)",
    ['kubic audit', 'kubic audit --result deny --json'],
  )
    .option('--posture <name>', 'filter on posture')
    .option('--result <result>', 'filter on result: ok|deny|error')
    .option('--session <id>', 'filter on one session')
    .option('--json', JSON_HELP)
    .action(async (options) => done(await runners.audit(options, config)));

  command(
    program,
    'eval',
    'score one suite against a task prompt or a recorded trajectory',
    [
      'kubic eval --trajectory "$(cat t.json)" --suite bugfix-repro --size smoke',
    ],
  )
    .requiredOption('--suite <id>', 'built-in suite to score')
    .option('--task <prompt>', 'execute the suite against a task prompt')
    .option(
      '--trajectory <file>',
      'score a trajectory export file (`-` reads stdin; inline JSON is kept for back-compat)',
    )
    .option(
      '--model <id>',
      `${MODEL_HELP} (--task default ${EVAL_DEFAULT_MODEL})${FROM_EXPORT}`,
    )
    .option('--worktree <path>', `${WORKTREE_HELP}${FROM_EXPORT}`)
    .option(
      '--generation <n>',
      `${GENERATION_HELP}; required with --task${FROM_EXPORT}`,
    )
    .option('--size <size>', SIZE_HELP)
    .option('--workspace <kind>', WORKSPACE_HELP)
    .option('--thinking <level>', `${THINKING_HELP}${FROM_EXPORT}`)
    .option('--json', ENVELOPE_HELP)
    .action(async (options) => done(await runners.eval(options, config)));

  command(
    program,
    'benchmark',
    'run the reproducible suite matrix (stub suites are reported, never passed)',
    ['kubic benchmark --worktree wt --generation 1 --size smoke --json'],
  )
    .option('--suite <id>', 'one suite instead of the whole matrix')
    .option('--model <id>', MODEL_HELP, EVAL_DEFAULT_MODEL)
    .option('--worktree <path>', WORKTREE_HELP)
    .requiredOption('--generation <n>', GENERATION_HELP)
    .option('--size <size>', SIZE_HELP)
    .option('--workspace <kind>', WORKSPACE_HELP)
    .option('--thinking <level>', THINKING_HELP)
    .option('--json', ENVELOPE_HELP)
    .action(async (options) => done(await runners.benchmark(options, config)));

  command(
    program,
    'replay',
    'replay a recorded trajectory at a declared determinism tier',
    [
      'kubic replay traj.json',
      'kubic replay --session 3f2a',
      'kubic replay traj.json --tier deterministic --model faux/echo --lockfile pins.lock',
      'kubic replay traj.json --diff-against other.json --json',
    ],
  )
    .argument('[trajectory]', 'trajectory export file (.json)')
    .option('--session <id>', SESSION_TRAJECTORY_HELP)
    .option('--tier <tier>', 'recorded|deterministic|live (default recorded)')
    .option('--model <provider/id>', 'deterministic tier: the pinned model')
    .option('--lockfile <path>', 'deterministic tier: the pin lockfile')
    .option('--role-config <path>', 'live tier: the pinned role config')
    .option('--worktree <path>', 'experimental: re-execute in another worktree')
    .option(
      '--diff-against <other.json>',
      'compare against another trajectory (exit 1 on a regression)',
    )
    .option('--json', ENVELOPE_HELP)
    .action(async (trajectory, options) =>
      done(
        await runners.replay(
          trajectory === undefined ? options : { ...options, trajectory },
          config,
        ),
      ),
    );

  command(
    program,
    'export',
    'describe a trajectory export or build one RL dataset record from it',
    [
      'kubic export --trajectory t.json',
      'kubic export --session 3f2a --type sft',
      'kubic export --trajectory a.json --type dpo --against b.json --json',
      'kubic export --dataset traj/ --type dpo --out pairs.jsonl',
    ],
  )
    .option('--trajectory <file>', 'trajectory export file')
    .option('--session <id>', SESSION_TRAJECTORY_HELP)
    .option('--type <type>', `dataset record: ${DATASET_TYPES.join('|')}`)
    .option(
      '--dataset <dir|glob>',
      'batch mode: every trajectory in a directory or glob',
    )
    .option(
      '--out <file.jsonl>',
      'batch mode: stream the dataset records into this JSONL file',
    )
    .option(
      '--against <other.json>',
      'second trajectory for dpo|preference|grpo',
    )
    .option('--json', ENVELOPE_HELP)
    .action(async (options) => done(await runners.export(options, config)));
};
