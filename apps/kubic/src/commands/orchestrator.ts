// Orchestrator-mode commands (delegation is a mode): orchestrate, clean,
// workers. Registered on the root program by ../dispatch.ts.
//
// commander owns the argv: every flag is declared here, `--help` is the
// generated help, and every syntax or value problem (unknown flag, missing
// value, stray operand, malformed `--agents` / `--budget` / `--session` /
// retention bound, `--all` with `--session`) exits 2 with one `error: …`
// line on stderr before a handler runs (§78). The handlers
// (packages/host) receive typed options and own the run itself.

import { InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { BUDGET_DIMENSIONS } from '../../../../packages/agents/src/budget.js';
import { CliUsageError } from '../../../../packages/core/src/cli/exit-codes.js';
import {
  type ParsedBudgetSpec,
  parseAgentBindings,
  parseBudgetSpec,
} from '../../../../packages/host/src/orchestrate-cli.js';
import type { CleanOptions } from '../../../../packages/host/src/orchestrator/worktree/clean.js';
import { SESSION_ID_PATTERN } from '../../../../packages/host/src/run-cli.js';
import type { CommandRegistrar } from '../cli/context.js';

// Value parsers: commander calls them with the raw option value and turns
// an InvalidArgumentError into `error: option '<flag>' argument '<v>' is
// invalid. <reason>` (exit 2).
function sessionId(raw: string): string {
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new InvalidArgumentError('Session ids use only [A-Za-z0-9_-].');
  }
  return raw;
}

function agentList(raw: string): string[] {
  const parsed = parseAgentBindings(raw);
  if (!parsed.ok) {
    throw new InvalidArgumentError(parsed.reason);
  }
  return parsed.entries;
}

function budgetSpec(raw: string): ParsedBudgetSpec {
  const spec = parseBudgetSpec(raw);
  if (spec === undefined) {
    throw new InvalidArgumentError(
      `Use <dim>=<n>[,…], <agent>:<dim>=<n>[;…] or total:<dim>=<n> (aggregate task cap) with positive numbers; dims: ${BUDGET_DIMENSIONS.join(', ')}.`,
    );
  }
  return spec;
}

// A repeatable flag's collector: commander calls it once per occurrence.
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInt(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError('Needs a positive integer.');
  }
  return value;
}

// The worker-failure policy (issue #169): `stop` is the shipped all-or-nothing
// default, `continue` keeps the run going and exits 7 with the failures named.
// An unknown value is a usage error, never a silently ignored flag.
function failureMode(raw: string): 'stop' | 'continue' {
  if (raw !== 'stop' && raw !== 'continue') {
    throw new InvalidArgumentError("Use 'stop' or 'continue'.");
  }
  return raw;
}

const ORCHESTRATE_EXAMPLES = `
Examples:
  kubic orchestrate -p "add input validation" --agents api,ui
  kubic orchestrate -p "add input validation" --agents api:implementer,ui:reviewer
  kubic orchestrate -p "fix the flaky tests" --yes --budget maxToolCalls=20
  kubic orchestrate -p "refactor" --concurrency 4 --agents api,ui,docs,cli
  kubic orchestrate -p "migrate the modules" --agents a,b,c --on-failure continue
  kubic orchestrate -p "use our conventions" --skill ./skills/house-style
  kubic orchestrate --resume --session orch-1790000000000
  kubic orchestrate -p "refactor" --json

Each --agents entry is <id>[:<role>[:<provider/id>]], where <role> is one
of planner, implementer, tester, debugger, reviewer (default: implementer).

Needs a git repository (it never falls back to solo). Workers run
concurrently up to --concurrency (default [orchestrator].maxWorkers, else
4); the rest queue and start as slots free. Exit codes: 0 ok,
1 run failure, 2 usage or not a git repo, 3 budget exhausted, 4 approval
denied or timed out, 7 partial (--on-failure continue with failed workers).`;

const CLEAN_EXAMPLES = `
Examples:
  kubic clean --dry-run
  kubic clean --session orch-1790000000000
  kubic clean --journal --max-age-ms 604800000

Removes only Kubic's own retained worktrees (under the orchestrator root, on
a kubic/<session>/<agent> branch) and those branches. Exit codes: 0 ok (also a
dry run), 1 a hard failure, 2 usage or not a git repo.`;

export const registerOrchestratorCommands: CommandRegistrar = (
  program,
  ctx,
) => {
  const { runners, config } = ctx;

  program
    .command('orchestrate')
    .description(
      'run a manager with one worker process and git worktree per subagent (opt-in)',
    )
    .option(
      '-p, --prompt <text>',
      'the objective; each worker runs its own plan step (required unless --resume)',
    )
    .option(
      '--agents <ids>',
      'comma-separated workers as <id>[:<role>[:<provider/id>]]; roles: planner|implementer|tester|debugger|reviewer (default: worker-1,worker-2 as implementers)',
      agentList,
    )
    .option(
      '--concurrency <n>',
      'max workers running at once for this run (overrides [orchestrator].maxWorkers)',
      positiveInt,
    )
    .option(
      '--manager-lane',
      'drive this run through the model-driven manager lane instead of the deterministic template plan (needs a resolvable manager model; overrides [orchestrator].manager)',
    )
    .option(
      '--on-failure <mode>',
      "what one worker's failure does to the run: 'stop' (default) fails the run, 'continue' merges the survivors and exits 7",
      failureMode,
    )
    .option(
      '--session <id>',
      'orchestrator session id (default: orch-<now>)',
      sessionId,
    )
    .option(
      '--resume',
      're-attach to a killed run and merge its pending workers (needs --session)',
    )
    .option('--yes', 'auto-approve every merge (non-interactive)')
    .option(
      '--autonomous',
      'run to completion without stopping for input (§19; recorded in the session and audit)',
    )
    .option(
      '--skill <path>',
      'skill every worker and the resolver are granted (repeatable); a relative path resolves against this cwd',
      collect,
      [],
    )
    .option(
      '--budget <dims>',
      'opt-in per-worker budget, e.g. maxToolCalls=20 or w1:maxCostUsd=1;w2:maxTokens=5000; total:maxCostUsd=5 caps the whole task',
      budgetSpec,
    )
    .option(
      '--dangerously-skip-approvals',
      'skip approvals for this session only (indicated and recorded)',
    )
    .option('--full-access', 'deprecated alias of --dangerously-skip-approvals')
    .option('--json', 'print one JSON envelope on stdout')
    .addHelpText('after', ORCHESTRATE_EXAMPLES)
    .action(
      async ({ dangerouslySkipApprovals, fullAccess, skill, ...rest }) => {
        // Issue #308: one flag name for full access across every command;
        // `--full-access` still works and says what replaced it.
        if (fullAccess === true) {
          ctx.err(
            'hint: --full-access is deprecated — use --dangerously-skip-approvals',
          );
        }
        // Issue #170: `--skill` is repeatable; the typed option is the list.
        const base = { ...rest, skills: skill ?? [] };
        const options =
          dangerouslySkipApprovals === true || fullAccess === true
            ? { ...base, fullAccess: true }
            : base;
        ctx.setExitCode(await runners.orchestrate(options, config));
      },
    );

  program
    .command('clean')
    .description(
      'remove retained orchestrator worktrees, kubic/<session>/<agent> branches and old journal entries',
    )
    .addOption(
      new Option(
        '--all',
        'every retained worktree and branch (the default)',
      ).conflicts('session'),
    )
    .option(
      '--session <id>',
      'only the worktrees of one orchestrate run (from <repo>/.kubic/orchestrator/<id>.json)',
      sessionId,
    )
    .option('--dry-run', 'print what would be removed; change nothing')
    .option(
      '--force',
      'remove dirty worktrees and stop still-live workers first',
    )
    .option(
      '--journal',
      'also prune the journal (to the default byte bound unless a bound is given)',
    )
    .option(
      '--max-age-ms <n>',
      'journal retention: drop entries older than n ms',
      positiveInt,
    )
    .option(
      '--max-bytes <n>',
      'journal retention: keep at most n bytes',
      positiveInt,
    )
    .option(
      '--all-sessions',
      'with --journal, prune session journals of every workspace, not just this one',
    )
    .option('--json', 'print one JSON envelope on stdout')
    .addHelpText('after', CLEAN_EXAMPLES)
    .action(async ({ session, ...rest }) => {
      const options: CleanOptions = {
        ...rest,
        ...(session === undefined ? {} : { sessionId: session }),
      };
      ctx.setExitCode(await runners.clean(options, config));
    });

  // `kubic workers` is a group (issue #167; the `sessions` shape): the bare
  // form lists, `inspect <id>` shows one worker, `terminate <id>` stops one.
  // The group action owns the operands so an unknown subcommand is the
  // documented `error: unknown command '<name>'` (exit 2), not commander's
  // excess-arguments line.
  const workers = program
    .command('workers')
    .description('list, inspect or terminate orchestrator workers')
    .option('--json', 'print the rows as one JSON array')
    .option(
      '--debug',
      'also print §50 spawn/exit lines on stderr (or KUBIC_DEBUG=1)',
    )
    .allowExcessArguments();
  workers.action(async (options, command) => {
    const name = command.args[0] as string | undefined;
    if (name === undefined) {
      ctx.setExitCode(
        await runners.workers({ command: 'list', ...options }, config),
      );
      return;
    }
    throw new CliUsageError(`unknown command '${name}' (inspect | terminate)`);
  });
  workers
    .command('inspect')
    .description("show one worker's row, worktree, budget, usage and approvals")
    .argument('<id>', 'the worker id', sessionId)
    .option('--json', 'print the worker as one JSON object')
    .action(async (id, options) => {
      ctx.setExitCode(
        await runners.workers({ command: 'inspect', id, ...options }, config),
      );
    });
  workers
    .command('terminate')
    .description('stop a runaway worker via the lifecycle layer (group reap)')
    .argument('<id>', 'the worker id', sessionId)
    .option(
      '--generation <n>',
      'only stop the generation the operator saw (a replaced worker is refused)',
      positiveInt,
    )
    .option('--json', 'print the termination as one JSON object')
    .action(async (id, options) => {
      ctx.setExitCode(
        await runners.workers({ command: 'terminate', id, ...options }, config),
      );
    });
};
