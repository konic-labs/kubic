// Solo-mode commands (the architecture, not a mode): run, tui, doctor,
// models, config, sessions. Registered on the root program by
// ../dispatch.ts; this module is the one place their commander
// definitions live — every flag, operand and value rule below is the
// command's whole argv surface, and the generated `--help` is its usage.
//
// Usage errors (unknown flag, missing value, a value the rules refuse,
// stray operands) exit 2 through the program's parse-error mapping; the
// runners receive typed options and never see argv.

import {
  type Command,
  InvalidArgumentError,
} from '@commander-js/extra-typings';
import { CliUsageError } from '../../../../packages/core/src/cli/exit-codes.js';
import {
  checkPromptValue,
  parseRunMaxTurns,
  parseRunTimeout,
  parseSessionIdArg,
  shellQuote,
} from '../../../../packages/host/src/run-cli.js';
import type { CommandContext, CommandRegistrar } from '../cli/context.js';

// A host value rule as a commander argument parser: its refusal becomes
// commander's `option '…' argument '…' is invalid. <reason>` (exit 2).
function rule<T>(parse: (value: string) => T): (value: string) => T {
  return (value) => {
    try {
      return parse(value);
    } catch (error) {
      throw new InvalidArgumentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

// Repeatable value flags collect into an array, in argv order.
function collect<T>(
  parse: (value: string) => T,
): (value: string, previous: T[]) => T[] {
  const one = rule(parse);
  return (value, previous) => [...previous, one(value)];
}

function nonNegativeInt(what: string): (value: string) => number {
  return rule((value) => {
    if (!/^\d+$/.test(value)) throw new Error(`need a non-negative ${what}`);
    return Number(value);
  });
}

function examples(lines: readonly string[]): string {
  return `\nExamples:\n${lines.map((line) => `  $ ${line}`).join('\n')}`;
}

// `-p <text>` vs `--prompt=<text>` / `-p<text>`: only the attached forms
// may carry a prompt that starts with `--` (the typo guard).
function promptWasAttached(rest: readonly string[], prompt: string): boolean {
  return rest.some(
    (token) => token === `--prompt=${prompt}` || token === `-p${prompt}`,
  );
}

function registerRun(program: Command, ctx: CommandContext): void {
  program
    .command('run')
    .description(
      'run one headless prompt in this repo (solo: no isolation — approvals and the journal are the controls)',
    )
    .option('-p, --prompt <text>', 'the prompt to run (required)')
    .option(
      '--session <id>',
      'resume into an existing session ([A-Za-z0-9_-])',
      rule(parseSessionIdArg),
    )
    .option(
      '--timeout <ms>',
      'wall-clock bound in ms (default 300000, max 2147483647)',
      rule(parseRunTimeout),
    )
    .option(
      '--max-turns <n>',
      'turn bound (positive integer)',
      rule(parseRunMaxTurns),
    )
    .option('--role <name>', 'boot as the role in .kubic/roles/<name>.md')
    .option(
      '--skill <path>',
      'add one skill explicitly (repeatable)',
      collect((value: string) => value),
      [] as string[],
    )
    .option('--no-skills', 'disable layered skill discovery')
    .option('--debug', 'emit lane/tool span lines on stderr')
    .option('--json', 'print one JSON envelope line instead of text')
    .allowExcessArguments()
    .addHelpText(
      'after',
      examples([
        "kubic run -p 'fix the failing test'",
        "kubic run -p 'summarise src/' --json",
        "kubic run --prompt='--flag-like prompt'",
        'KUBIC_PROVIDER=faux kubic run -p hello   # testing provider, no model',
      ]),
    )
    .action(async (opts, command) => {
      const operands = command.args;
      if (opts.prompt === undefined) {
        if (operands.length > 0) {
          // `kubic run "fix tests"` is the natural first try: name the
          // operand and the exact flag form (single-quoted, so nothing
          // expands when pasted).
          throw new CliUsageError(
            `unexpected argument ${JSON.stringify(operands[0])} — the prompt is a flag: kubic run -p ${shellQuote(operands.join(' '))}`,
          );
        }
        throw new CliUsageError(
          "required option '-p, --prompt <text>' not specified",
        );
      }
      if (operands.length > 0) {
        throw new CliUsageError(
          `unexpected argument ${JSON.stringify(operands[0])}`,
        );
      }
      let prompt: string;
      try {
        prompt = checkPromptValue(
          opts.prompt,
          promptWasAttached(ctx.rest, opts.prompt),
        );
      } catch (error) {
        throw new CliUsageError(
          `invalid -p/--prompt: ${(error as Error).message}`,
        );
      }
      ctx.setExitCode(
        await ctx.runners.run(
          {
            prompt,
            ...(opts.session === undefined ? {} : { session: opts.session }),
            ...(opts.timeout === undefined ? {} : { timeoutMs: opts.timeout }),
            ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
            ...(opts.role === undefined ? {} : { role: opts.role }),
            ...(opts.skill.length === 0 ? {} : { skills: opts.skill }),
            ...(opts.skills === false ? { noSkills: true } : {}),
            ...(opts.debug === true ? { debug: true } : {}),
            ...(opts.json === true ? { json: true } : {}),
          },
          ctx.config,
        ),
      );
    });
}

function registerTui(program: Command, ctx: CommandContext): void {
  program
    .command('tui')
    .description('open the interactive terminal UI (solo: no isolation)')
    .option(
      '--session <id>',
      'resume into an existing session ([A-Za-z0-9_-])',
      rule(parseSessionIdArg),
    )
    .option('--role <name>', 'boot as the role in .kubic/roles/<name>.md')
    .option(
      '--skill <path>',
      'add one skill explicitly (repeatable)',
      collect((value: string) => value),
      [] as string[],
    )
    .option('--no-skills', 'disable layered skill discovery')
    .addHelpText(
      'after',
      examples(['kubic tui', 'kubic tui --session my-session --role reviewer']),
    )
    .action(async (opts) => {
      ctx.setExitCode(
        await ctx.runners.tui(
          {
            ...(opts.session === undefined ? {} : { session: opts.session }),
            ...(opts.role === undefined ? {} : { role: opts.role }),
            ...(opts.skill.length === 0 ? {} : { skills: opts.skill }),
            ...(opts.skills === false ? { noSkills: true } : {}),
          },
          ctx.config,
        ),
      );
    });
}

function registerDoctor(program: Command, ctx: CommandContext): void {
  program
    .command('doctor')
    .description('check dependencies, providers, policy and limits')
    .option(
      '--skip <ids>',
      'skip checks by id (comma-separated, repeatable)',
      collect((value: string) => value),
      [] as string[],
    )
    .option('--json', 'print one JSON report')
    .addHelpText(
      'after',
      examples([
        'kubic doctor',
        'kubic doctor --skip node,license:kubic --json',
      ]),
    )
    .action(async (opts) => {
      ctx.setExitCode(
        await ctx.runners.doctor(
          {
            skip: opts.skip,
            ...(opts.json === true ? { json: true } : {}),
          },
          ctx.config,
        ),
      );
    });
}

function registerModels(program: Command, ctx: CommandContext): void {
  program
    .command('models')
    .description('list the model catalog or resolve one model')
    .option('--json', 'print the catalog as one JSON document')
    .option(
      '--resolve <provider/id>',
      'resolve one model through the selection chain',
    )
    .addHelpText(
      'after',
      examples(['kubic models', 'kubic models --resolve faux/echo']),
    )
    .action(async (opts) => {
      ctx.setExitCode(
        await ctx.runners.models(
          {
            ...(opts.json === true ? { json: true } : {}),
            ...(opts.resolve === undefined ? {} : { resolve: opts.resolve }),
          },
          ctx.config,
        ),
      );
    });
}

function registerConfig(program: Command, ctx: CommandContext): void {
  program
    .command('config')
    .description(
      'show the effective configuration and where each value came from',
    )
    .option('--json', 'print the effective configuration as JSON')
    .action(async (opts) => {
      ctx.setExitCode(
        await ctx.runners.config(
          opts.json === true ? { json: true } : {},
          ctx.config,
        ),
      );
    });
}

// `kubic trust` (issue #228): the durable project-trust grant. It is a
// config-command sibling — it must run while the project layer is refused
// (that is the case it repairs), so `configRefusalExit` lets it through.
function registerTrust(program: Command, ctx: CommandContext): void {
  program
    .command('trust')
    .description(
      'record, revoke or list project trust for a committed .kubic/config.toml',
    )
    .argument(
      '[path]',
      'the project directory to trust (default: the current directory)',
    )
    .option('--revoke', 'remove the recorded decision — the refusal comes back')
    .option('--list', 'list every recorded decision')
    .addHelpText(
      'after',
      examples([
        'kubic trust',
        'kubic trust --list',
        'kubic trust --revoke',
        'kubic trust ../another-repo',
      ]),
    )
    .action(async (path, opts) => {
      ctx.setExitCode(
        await ctx.runners.trust(
          {
            ...(path === undefined ? {} : { path }),
            ...(opts.revoke === true ? { revoke: true } : {}),
            ...(opts.list === true ? { list: true } : {}),
          },
          ctx.config,
        ),
      );
    });
}

function registerSessions(program: Command, ctx: CommandContext): void {
  const sessions = program
    .command('sessions')
    .description('create, list, attach to or prune sessions');
  const run = async (
    invocation: Parameters<CommandContext['runners']['sessions']>[0],
  ): Promise<void> => {
    ctx.setExitCode(await ctx.runners.sessions(invocation, ctx.config));
  };
  sessions
    .command('create')
    .description('create a new session and print its id')
    .option('--cwd <path>', 'the session working directory (default: cwd)')
    .option(
      '--dangerously-skip-approvals',
      'record session-scoped full access (never implied)',
    )
    .action(async (opts) => {
      await run({
        command: 'create',
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.dangerouslySkipApprovals === true
          ? { dangerouslySkipApprovals: true }
          : {}),
      });
    });
  sessions
    .command('list')
    .description('list the recorded sessions')
    .option('--json', 'print one JSON array')
    .action(async (opts) => {
      await run({
        command: 'list',
        ...(opts.json === true ? { json: true } : {}),
      });
    });
  sessions
    .command('attach')
    .description('print a session’s metadata, posture and transcript tail')
    .argument('<id>', 'the session id ([A-Za-z0-9_-])', rule(parseSessionIdArg))
    .option(
      '--tail <n>',
      'transcript entries to print (default 10)',
      nonNegativeInt('integer'),
    )
    .action(async (id, opts) => {
      await run({
        command: 'attach',
        id,
        ...(opts.tail === undefined ? {} : { tail: opts.tail }),
      });
    });
  sessions
    .command('prune')
    .description(
      'delete aged session state (a dry run unless --yes; asks on a terminal)',
    )
    .option(
      '--keep-days <n>',
      'keep sessions younger than n days (default: [session] retentionDays)',
      nonNegativeInt('integer of days'),
    )
    .option(
      '--keep-session <id>',
      'never prune this session (repeatable)',
      collect(parseSessionIdArg),
      [] as string[],
    )
    .option('--yes', 'delete without asking')
    .option('--dry-run', 'only report what would be pruned')
    .addHelpText(
      'after',
      examples([
        'kubic sessions prune --keep-days 30',
        'kubic sessions prune --keep-days 30 --keep-session main --yes',
      ]),
    )
    .action(async (opts) => {
      if (opts.yes === true && opts.dryRun === true) {
        throw new CliUsageError(
          '--yes and --dry-run contradict — deletion is explicit, pass one',
        );
      }
      await run({
        command: 'prune',
        ...(opts.keepDays === undefined ? {} : { keepDays: opts.keepDays }),
        keepSession: opts.keepSession,
        ...(opts.yes === true ? { yes: true } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
      });
    });
}

export const registerSoloCommands: CommandRegistrar = (program, ctx) => {
  registerRun(program, ctx);
  registerTui(program, ctx);
  registerDoctor(program, ctx);
  registerModels(program, ctx);
  registerConfig(program, ctx);
  registerTrust(program, ctx);
  registerSessions(program, ctx);
};
