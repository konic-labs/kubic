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
import {
  parseModelFlag,
  parseThinkingFlag,
} from '../../../../packages/agent/src/model-select.js';
import { CliUsageError } from '../../../../packages/core/src/cli/exit-codes.js';
import {
  checkPromptValue,
  parseRunMaxTurns,
  parseRunTimeout,
  parseSessionIdArg,
} from '../../../../packages/host/src/run-cli.js';
import type { CommandContext, CommandRegistrar } from '../cli/context.js';

// The `--model` help: one sentence per behaviour the
// flag actually has, no promise the cli layer does not keep.
const MODEL_FLAG_HELP =
  'override the model for this invocation (provider/id; beats env and file, never a frozen enterprise key)';
const MODEL_FLAG_HELP_REPORT =
  'report the config as if this model were passed (provider/id; the cli layer)';
// The `--thinking` help: one sentence per behaviour the
// flag actually has, no promise the cli layer does not keep.
const THINKING_FLAG_HELP =
  'override the thinking level for this invocation (beats env and file, never a frozen enterprise key)';
const THINKING_FLAG_HELP_REPORT =
  'report the config as if this level were passed (the cli layer)';

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

// `--tools read,ls` — one comma-separated
// value, repeatable. An empty list is a usage error (use `--no-tools` for
// the empty set); unknown names and class conflicts are refused by the
// runner/boot with the reason.
function toolList(value: string): string[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) {
    throw new InvalidArgumentError('needs at least one tool name');
  }
  return names;
}

// commander's negated `--no-tools` can leave `false` as the previous value
// (the order `--no-tools --tools x`), which the shared collector would try
// to spread. Tolerating it lets the parse finish so the action's raw-argv
// mutual-exclusion check can refuse both forms cleanly.
function collectTools(): (value: string, previous: string[][]) => string[][] {
  const one = rule(toolList);
  return (value, previous) => [
    ...(Array.isArray(previous) ? previous : []),
    one(value),
  ];
}

// commander's `--no-tools` negates the `tools` option (its value becomes
// false), so both selection forms arrive on one key. Normalize to
// (names, noTools) and refuse both-given from the raw argv — order decides
// which value commander keeps, and a silent last-wins would be the
// dishonest half.
function toolSelectionOf(
  parsed: false | string[][] | undefined,
  rest: readonly string[],
): { tools: string[]; noTools: boolean } {
  const rawTools = rest.some(
    (token) => token === '--tools' || token.startsWith('--tools='),
  );
  const rawNoTools = rest.includes('--no-tools');
  if (rawTools && rawNoTools) {
    throw new CliUsageError(
      '--tools and --no-tools are mutually exclusive — pass one',
    );
  }
  return {
    tools: Array.isArray(parsed) ? parsed.flat() : [],
    noTools: parsed === false,
  };
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
    .option(
      '-p, --prompt <text>',
      'the prompt to run (or pass it positionally)',
    )
    .argument(
      '[prompt]',
      'the prompt to run (alternative to -p/--prompt; use -- before one starting with -)',
    )
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
    .option('--model <provider/id>', MODEL_FLAG_HELP, rule(parseModelFlag))
    .option('--thinking <level>', THINKING_FLAG_HELP, rule(parseThinkingFlag))
    .option('--role <name>', 'boot as the role in .kubic/roles/<name>.md')
    .option(
      '--skill <path>',
      'add one skill explicitly (repeatable)',
      collect((value: string) => value),
      [] as string[],
    )
    .option('--no-skills', 'disable layered skill discovery')
    // Invoke one explicit skill — hidden skills
    // included — as the turn prompt (run only; the TUI uses /skill:).
    .option(
      '--invoke-skill <name>',
      'invoke one explicit skill first, its content as the turn prompt with -p/positional text as instructions',
    )
    .option('--debug', 'emit lane/tool span lines on stderr')
    .option(
      '--autonomous',
      'run to completion without stopping for input (recorded in the session and audit)',
    )
    .option('--json', 'print one JSON envelope line instead of text')
    .option(
      '--dangerously-skip-approvals',
      'enable full access (no approval asks) for THIS session only — recorded in posture.json and the audit ledger, never in config',
    )
    .option(
      '--tools <a,b,...>',
      'narrow the tool set to these tools (comma-separated, repeatable; intersected with the permission classes and any --role set)',
      collectTools(),
      [] as string[][],
    )
    .option('--no-tools', 'run with no tools at all (chat only)')
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
    .action(async (positional, opts, command) => {
      const operands = command.args;
      if (opts.prompt !== undefined && positional !== undefined) {
        throw new CliUsageError(
          'both -p/--prompt and a positional prompt were given — pass exactly one (kubic run -p <text>, or kubic run <text>)',
        );
      }
      if (operands.length > 1) {
        throw new CliUsageError(
          `unexpected argument ${JSON.stringify(operands[1])} — pass exactly one prompt`,
        );
      }
      const text = opts.prompt ?? positional;
      if (text === undefined) {
        throw new CliUsageError(
          "required option '-p, --prompt <text>' not specified (or pass the prompt as a positional argument)",
        );
      }
      // The typo guard is `-p`-only: a separate-token value that starts with
      // `--` is a mistyped flag. A positional prompt that starts with `-`
      // reaches us only after `--`, which is the explicit opt-in.
      const fromFlag = opts.prompt !== undefined;
      let prompt: string;
      try {
        prompt = checkPromptValue(
          text,
          !fromFlag || promptWasAttached(ctx.rest, text),
        );
      } catch (error) {
        throw new CliUsageError(
          `${fromFlag ? 'invalid -p/--prompt' : 'invalid prompt'}: ${(error as Error).message}`,
        );
      }
      // The two selection forms are
      // mutually exclusive; both at once is a usage error naming both.
      const selection = toolSelectionOf(opts.tools, ctx.rest);
      ctx.finish(
        await ctx.runners.run(
          {
            prompt,
            ...(opts.session === undefined ? {} : { session: opts.session }),
            ...(opts.timeout === undefined ? {} : { timeoutMs: opts.timeout }),
            ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
            ...(opts.role === undefined ? {} : { role: opts.role }),
            ...(opts.skill.length === 0 ? {} : { skills: opts.skill }),
            // The explicit skill invocation travels to
            // the runner, which expands it against the booted skills.
            ...(opts.invokeSkill === undefined
              ? {}
              : { invokeSkill: opts.invokeSkill }),
            ...(opts.skills === false ? { noSkills: true } : {}),
            ...(opts.debug === true ? { debug: true } : {}),
            ...(opts.autonomous === true ? { autonomous: true } : {}),
            ...(opts.json === true ? { json: true } : {}),
            ...(opts.dangerouslySkipApprovals === true
              ? { dangerouslySkipApprovals: true }
              : {}),
            ...(selection.tools.length === 0 ? {} : { tools: selection.tools }),
            ...(selection.noTools ? { noTools: true } : {}),
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
    .option('--model <provider/id>', MODEL_FLAG_HELP, rule(parseModelFlag))
    .option('--thinking <level>', THINKING_FLAG_HELP, rule(parseThinkingFlag))
    .option('--role <name>', 'boot as the role in .kubic/roles/<name>.md')
    .option(
      '--skill <path>',
      'add one skill explicitly (repeatable)',
      collect((value: string) => value),
      [] as string[],
    )
    .option('--no-skills', 'disable layered skill discovery')
    .option(
      '--dangerously-skip-approvals',
      'enable full access (no approval asks) for THIS session only — recorded in posture.json and the audit ledger, never in config',
    )
    .option(
      '--tools <a,b,...>',
      'narrow the tool set to these tools (comma-separated, repeatable; intersected with the permission classes and any --role set)',
      collectTools(),
      [] as string[][],
    )
    .option('--no-tools', 'run with no tools at all (chat only)')
    .addHelpText(
      'after',
      examples([
        'kubic tui',
        'kubic tui --session my-session --role reviewer',
        'kubic tui --model anthropic/claude-sonnet-4-5',
      ]),
    )
    .action(async (opts) => {
      // Both selection forms at once is a
      // usage error naming both (the boot re-validates names/agreement).
      const selection = toolSelectionOf(opts.tools, ctx.rest);
      ctx.finish(
        await ctx.runners.tui(
          {
            ...(opts.session === undefined ? {} : { session: opts.session }),
            ...(opts.role === undefined ? {} : { role: opts.role }),
            ...(opts.skill.length === 0 ? {} : { skills: opts.skill }),
            ...(opts.skills === false ? { noSkills: true } : {}),
            ...(opts.model === undefined ? {} : { model: opts.model }),
            ...(opts.dangerouslySkipApprovals === true
              ? { dangerouslySkipApprovals: true }
              : {}),
            ...(selection.tools.length === 0 ? {} : { tools: selection.tools }),
            ...(selection.noTools ? { noTools: true } : {}),
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
    .option(
      '--verbose',
      'print every check in full (the default on a terminal is a grouped summary)',
    )
    .option(
      '--session <id>',
      'check one session (its installed posture and full-access state)',
    )
    .addHelpText(
      'after',
      examples([
        'kubic doctor',
        'kubic doctor --verbose',
        'kubic doctor --skip node,license:kubic --json',
      ]),
    )
    .action(async (opts) => {
      ctx.finish(
        await ctx.runners.doctor(
          {
            skip: opts.skip,
            ...(opts.json === true ? { json: true } : {}),
            ...(opts.verbose === true ? { verbose: true } : {}),
            ...(opts.session === undefined ? {} : { session: opts.session }),
          },
          ctx.config,
        ),
      );
    });
}

function registerSkills(program: Command, ctx: CommandContext): void {
  program
    .command('skills')
    .description('list discovered skills and why any were left out')
    .option('--role <name>', 'gate the listing as the lane would for this role')
    .option('--json', 'print the listing as one JSON array')
    .addHelpText(
      'after',
      examples(['kubic skills', 'kubic skills --role reviewer --json']),
    )
    .action(async (opts) => {
      ctx.finish(
        await ctx.runners.skills(
          {
            ...(opts.role === undefined ? {} : { role: opts.role }),
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
    .argument('[provider]', 'list one provider in full')
    .option('--all', 'include providers without a configured key')
    .option('--json', 'print the catalog as one JSON document')
    .option(
      '--resolve <provider/id>',
      'resolve one model through the selection chain',
    )
    .addHelpText(
      'after',
      examples([
        'kubic models',
        'kubic models anthropic',
        'kubic models --all',
        'kubic models --resolve faux/echo',
      ]),
    )
    .action(async (provider, opts) => {
      ctx.finish(
        await ctx.runners.models(
          {
            ...(provider === undefined ? {} : { provider }),
            ...(opts.all === true ? { all: true } : {}),
            ...(opts.json === true ? { json: true } : {}),
            ...(opts.resolve === undefined ? {} : { resolve: opts.resolve }),
          },
          ctx.config,
        ),
      );
    });
}

// `kubic setup` — provider, default model, thinking level
// and the project trust question, saved to ~/.kubic/config.toml.
function registerSetup(program: Command, ctx: CommandContext): void {
  program
    .command('setup')
    .description(
      'choose a provider and default model, saved to ~/.kubic/config.toml (interactive)',
    )
    .addHelpText('after', examples(['kubic setup']))
    .action(async () => {
      ctx.finish(await ctx.runners.setup({}, ctx.config));
    });
}

function registerConfig(program: Command, ctx: CommandContext): void {
  program
    .command('config')
    .description(
      'show the effective configuration and where each value came from',
    )
    .option('--json', 'print the effective configuration as JSON')
    .option(
      '--model <provider/id>',
      MODEL_FLAG_HELP_REPORT,
      rule(parseModelFlag),
    )
    .option(
      '--thinking <level>',
      THINKING_FLAG_HELP_REPORT,
      rule(parseThinkingFlag),
    )
    .action(async (opts) => {
      ctx.finish(
        await ctx.runners.config(
          opts.json === true ? { json: true } : {},
          ctx.config,
        ),
      );
    });
}

// `kubic trust`: the durable project-trust grant. It is a
// config-command sibling — it must run while the project layer is refused
// (that is the case it repairs), so `configRefusalExit` lets it through.
function registerTrust(program: Command, ctx: CommandContext): void {
  program
    .command('trust')
    .description(
      "record, revoke or list project trust — one grant covers the project's .kubic/config.toml, its models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names) and its project skills",
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
      ctx.finish(
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
    .description('create, list, attach to, fork or prune sessions')
    .option(
      '--json',
      'with no subcommand: list the sessions as one JSON array (same as `sessions list --json`)',
    )
    // The group action owns the operands so an unknown subcommand is the
    // documented `error: unknown command '<name>'` (exit 2), not commander's
    // excess-arguments line.
    .allowExcessArguments();
  const run = async (
    invocation: Parameters<CommandContext['runners']['sessions']>[0],
  ): Promise<void> => {
    ctx.finish(await ctx.runners.sessions(invocation, ctx.config));
  };
  // `kubic sessions --json` is the documented list form. The
  // group action also keeps the two usage errors named: no
  // subcommand, or an unknown one.
  sessions.action(async (opts, command) => {
    const name = command.args[0];
    if (name === undefined) {
      if (opts.json !== true) {
        throw new CliUsageError(
          'sessions needs a subcommand (create | list | attach | fork | prune)',
        );
      }
      await run({ command: 'list', json: true });
      return;
    }
    throw new CliUsageError(
      `unknown command '${name}' (create | list | attach | fork | prune)`,
    );
  });
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
    .option(
      '--ids',
      'prefix each line with its entry id (for `sessions fork --at`)',
    )
    .option('--json', 'print the raw tail entries as JSON (untruncated)')
    .action(async (id, opts) => {
      await run({
        command: 'attach',
        id,
        ...(opts.tail === undefined ? {} : { tail: opts.tail }),
        ...(opts.ids === true ? { ids: true } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
  sessions
    .command('fork')
    .description(
      'fork a session into a new one (at an entry, default the newest; --tree copies every branch)',
    )
    .argument(
      '<id>',
      'the source session id ([A-Za-z0-9_-])',
      rule(parseSessionIdArg),
    )
    .option(
      '--at <entry>',
      'fork at this entry id (inclusive; `kubic sessions attach --ids` shows them)',
      nonNegativeInt('integer entry id'),
    )
    .option('--tree', 'copy the whole tree: every conversation and branch tip')
    .option('--json', 'print {id, source, at} as one JSON document')
    .addHelpText(
      'after',
      examples([
        'kubic sessions fork <id>',
        'kubic sessions fork <id> --at 12 --json',
        'kubic tui --session "$(kubic sessions fork <id> --at 12)"',
      ]),
    )
    .action(async (id, opts) => {
      await run({
        command: 'fork',
        id,
        ...(opts.at === undefined ? {} : { at: opts.at }),
        ...(opts.tree === true ? { tree: true } : {}),
        ...(opts.json === true ? { json: true } : {}),
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

export const registerSessionCommands: CommandRegistrar = (program, ctx) => {
  registerRun(program, ctx);
  registerTui(program, ctx);
  registerReattach(program, ctx);
  registerDoctor(program, ctx);
  registerSkills(program, ctx);
  registerModels(program, ctx);
  registerSetup(program, ctx);
  registerConfig(program, ctx);
  registerTrust(program, ctx);
  registerSessions(program, ctx);
};

// The reattach aliases. `attach <id>` boots the
// interactive TUI on an existing session — a missing or live-locked session
// is the TUI boot's own workspace refusal (exit 5) — and `resume <id>` is
// the same boot, named the way lists it. The full flag surface stays on
// `kubic tui`; these are the documented shorthands.
function registerReattach(program: Command, ctx: CommandContext): void {
  const reattach = (name: 'attach' | 'resume'): void => {
    program
      .command(name)
      .description(
        name === 'attach'
          ? 'attach the interactive TUI to an existing session'
          : 'resume a session in the interactive TUI (same as `kubic tui --session <id>`)',
      )
      .argument(
        '<id>',
        'the session id ([A-Za-z0-9_-])',
        rule(parseSessionIdArg),
      )
      .addHelpText(
        'after',
        examples([
          `kubic ${name} my-session`,
          'kubic tui --session my-session --role reviewer   # the full flag surface',
        ]),
      )
      .action(async (id: string) => {
        ctx.finish(await ctx.runners.tui({ session: id }, ctx.config));
      });
  };
  reattach('attach');
  reattach('resume');
}
