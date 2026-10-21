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

import { CliUsageError, type CommandResult } from '@kubic/core/cli/exit-codes';
import { EVAL_DEFAULT_MODEL, type EvalOptions } from '@kubic/eval/cli';
import {
  DATASET_TYPES,
  type ExportCommandOptions,
} from '@kubic/eval/export-cli';
import type { AuditOptions } from '@kubic/host/audit';
import type { CostOptions } from '@kubic/host/cost';
import type { PolicyOptions } from '@kubic/host/policy';
import type { ReplayCommandOptions } from '@kubic/host/replay';
import { examples } from '../cli/argv.js';
import type { CommandRegistrar, KubicProgram } from '../cli/context.js';
import type { CliConfigResult } from '../config/load.js';

// One analysis runner: commander's parsed options plus the process-wide
// config load in, the command's result out (production wiring:
// ../runners/analysis.ts).
type AnalysisRunner<Options> = (
  options: Options,
  config: CliConfigResult,
) => CommandResult | Promise<CommandResult>;

export interface AnalysisRunners {
  readonly cost: AnalysisRunner<CostOptions>;
  readonly policy: AnalysisRunner<PolicyOptions>;
  readonly audit: AnalysisRunner<AuditOptions>;
  readonly eval: AnalysisRunner<EvalOptions>;
  readonly benchmark: AnalysisRunner<EvalOptions>;
  readonly replay: AnalysisRunner<ReplayCommandOptions & SessionOption>;
  readonly export: AnalysisRunner<ExportCommandOptions & SessionOption>;
}

// `--session <id>`: read the session's own trajectory
// (<sessions-root>/<id>/trajectory.json) instead of naming the file. The
// prod runner resolves it (./run/trajectory.ts resolveSessionTrajectory).
interface SessionOption {
  readonly session?: string;
}

const SESSION_TRAJECTORY_HELP =
  "read that run's trajectory: <sessions-root>/<id>/trajectory.json";

const JSON_HELP = 'print one JSON document on stdout';
const ENVELOPE_HELP =
  'print one JSON envelope on stdout (runtime failures included; a usage error stays on stderr)';
// eval and benchmark share the run flags.
const MODEL_HELP = 'provider/id of the run';
const WORKTREE_HELP =
  'the worktree the run executes in (--workspace worktree needs it clean); recorded as provenance';
const SIZE_HELP =
  'record size: smoke|standard|extended (the determinism tier is derived)';
const WORKSPACE_HELP =
  'inline|worktree (default inline; worktree needs a clean --worktree)';
const THINKING_HELP = 'thinking level, recorded verbatim';
// eval --trajectory reads model/thinking/worktree from the export: the flag
// only cross-checks it.
const FROM_EXPORT = '; --trajectory reads it from the export';

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

// `kubic audit`: the ledger query, its chain check and the collector flush.
function registerAudit(
  program: KubicProgram,
  ctx: Parameters<CommandRegistrar>[1],
): void {
  const { config, runners } = ctx;
  const done = (result: CommandResult): void => {
    ctx.finish(result);
  };
  const audit = command(
    program,
    'audit',
    "query the repo's approval audit ledger (redacted); verify its chain or flush the collector sinks",
    [
      'kubic audit',
      'kubic audit --result deny --json',
      'kubic audit --since 7d --format csv > audit.csv',
      'kubic audit verify',
      'kubic audit flush',
    ],
  )
    .option('--posture <name>', 'filter on posture')
    .option('--result <result>', 'filter on result: ok|deny|error')
    .option('--session <id>', 'filter on one session')
    .option(
      '--since <time>',
      'records at or after this time: ISO 8601, or an age such as 24h or 7d',
    )
    .option('--until <time>', 'records before this time, in the same forms')
    .option('--format <format>', 'table (default), json, jsonl or csv')
    .option('--json', JSON_HELP)
    .action(async (options) => done(await runners.audit(options, config)));
  audit
    .command('verify')
    .description(
      "check the ledger's hash chain and name the first line that does not hold",
    )
    .option(
      '--file <path>',
      'a chained [[audit]] file target instead of the repo ledger',
    )
    .option('--json', JSON_HELP)
    .action(async (options) =>
      done(
        await runners.audit(
          {
            command: 'verify',
            ...(options.file === undefined ? {} : { file: options.file }),
            ...(options.json === true ? { json: true } : {}),
          },
          config,
        ),
      ),
    );
  audit
    .command('flush')
    .description(
      'deliver what the collector sinks (tcp/tls syslog, https, otlp) hold in their spools now',
    )
    .action(async () =>
      done(await runners.audit({ command: 'flush' }, config)),
    );
}

// `kubic policy`: the tool query, and the managed-policy subcommands.
function registerPolicy(
  program: KubicProgram,
  ctx: Parameters<CommandRegistrar>[1],
): void {
  const { config, runners } = ctx;
  const done = (result: CommandResult): void => {
    ctx.finish(result);
  };
  const policy = command(
    program,
    'policy',
    'report the installed tool policy decision for one tool (a routing offer, never enforcement); explain, pull or sign the managed policy',
    [
      'kubic policy --tool shell',
      'kubic policy --tool network_fetch --json',
      'kubic policy explain',
      'kubic policy pull',
      'kubic policy sign --key policy.key /etc/kubic/config.toml',
    ],
  )
    .option('--tool <name>', 'the tool to query')
    .option('--json', JSON_HELP)
    .action(async (options) => {
      // `--tool` is required for the query itself; the subcommands take none.
      if (options.tool === undefined) {
        throw new CliUsageError(
          "required option '--tool <name>' not specified",
        );
      }
      done(await runners.policy(options, config));
    });
  policy
    .command('explain')
    .description(
      'print the effective policy: every [policy] key, the audit sinks and the keys the enterprise and product layers set, each with its layer, and where the managed config came from',
    )
    .option('--json', JSON_HELP)
    .action(async (options) =>
      done(
        await runners.policy(
          {
            command: 'explain',
            ...(options.json === true ? { json: true } : {}),
          },
          config,
        ),
      ),
    );
  policy
    .command('pull')
    .description(
      "fetch the organization's signed remote policy ([managed] url) now, verify it and cache it",
    )
    .action(async () =>
      done(await runners.policy({ command: 'pull' }, config)),
    );
  policy
    .command('sign')
    .description(
      'sign a managed config with an Ed25519 private key (PEM): writes <file>.sig beside it',
    )
    .argument('<file>', 'the managed config to sign')
    .requiredOption('--key <path>', 'the Ed25519 private key, in PEM form')
    .action(async (file, options) =>
      done(
        await runners.policy(
          { command: 'sign', file, key: options.key },
          config,
        ),
      ),
    );
}

export const registerAnalysisCommands: CommandRegistrar = (program, ctx) => {
  const { config, runners } = ctx;
  const done = (result: CommandResult): void => {
    ctx.finish(result);
  };

  command(
    program,
    'cost',
    'report token and dollar cost over stored sessions',
    [
      'kubic cost',
      'kubic cost --session 3f2a --json',
      'kubic cost --all --by team --format csv > spend.csv',
    ],
  )
    .option('--session <id>', 'read only this session ([A-Za-z0-9_-])')
    .option(
      '--all',
      'include sessions from every project (default: this project only)',
    )
    .option(
      '--by <level>',
      'group rows: request|session|project|user|team|model|day (default session)',
    )
    .option('--format <format>', 'table (default), json or csv')
    .option('--json', JSON_HELP)
    .action(async (options) => done(await runners.cost(options, config)));

  registerPolicy(program, ctx);

  registerAudit(program, ctx);

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
    .option('--size <size>', SIZE_HELP)
    .option('--workspace <kind>', WORKSPACE_HELP)
    .option('--thinking <level>', `${THINKING_HELP}${FROM_EXPORT}`)
    .option('--json', ENVELOPE_HELP)
    .action(async (options) => done(await runners.eval(options, config)));

  command(
    program,
    'benchmark',
    'run the reproducible suite matrix (stub suites are reported, never passed)',
    ['kubic benchmark --worktree wt --size smoke --json'],
  )
    .option('--suite <id>', 'one suite instead of the whole matrix')
    .option('--model <id>', MODEL_HELP, EVAL_DEFAULT_MODEL)
    .option('--worktree <path>', WORKTREE_HELP)
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
