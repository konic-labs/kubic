// The setup and diagnostics commands: doctor, skills, models, setup, config
// and trust. Registered on the root program by ../dispatch.ts; this module is
// the one place their commander definitions live, and the generated `--help`
// is their usage.
//
// Usage errors (unknown flag, missing value, a value the rules refuse,
// stray operands) exit 2 through the program's parse-error mapping; the
// runners receive typed options and never see argv.

import type { Command } from '@commander-js/extra-typings';
import { parseModelFlag, parseThinkingFlag } from '@kubic/agent/model-select';
import { collect, examples, rule } from '../cli/argv.js';
import type { CommandContext, CommandRegistrar } from '../cli/context.js';

const MODEL_FLAG_HELP_REPORT =
  'report the config as if this model were passed (provider/id; the cli layer)';
const THINKING_FLAG_HELP_REPORT =
  'report the config as if this level were passed (the cli layer)';

export const registerSetupCommands: CommandRegistrar = (program, ctx) => {
  registerDoctor(program, ctx);
  registerSkills(program, ctx);
  registerModels(program, ctx);
  registerSetup(program, ctx);
  registerConfig(program, ctx);
  registerTrust(program, ctx);
};

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
      "record, revoke or list project trust — one grant covers the project's .kubic/config.toml, its models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names), its AGENTS.md and its project skills",
    )
    .argument(
      '[path]',
      'the project directory to trust (default: the current directory)',
    )
    .option('--revoke', 'remove the recorded decision — the refusal comes back')
    .option('--list', 'list every recorded decision')
    .option(
      '--diff',
      'show what changed in the project since the last grant, and record nothing',
    )
    .addHelpText(
      'after',
      examples([
        'kubic trust',
        'kubic trust --diff',
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
            ...(opts.diff === true ? { diff: true } : {}),
          },
          ctx.config,
        ),
      );
    });
}
