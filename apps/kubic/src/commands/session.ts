// The session commands: run, tui, attach, resume and sessions. Registered on
// the root program by
// ../dispatch.ts; this module is the one place their commander
// definitions live — every flag, operand and value rule below is the
// command's whole argv surface, and the generated `--help` is its usage.
//
// Usage errors (unknown flag, missing value, a value the rules refuse,
// stray operands) exit 2 through the program's parse-error mapping; the
// runners receive typed options and never see argv.

import type { Command } from '@commander-js/extra-typings';
import { InvalidArgumentError } from '@commander-js/extra-typings';
import { parseModelFlag, parseThinkingFlag } from '@kubic/agent/model-select';
import { CliUsageError } from '@kubic/core/cli/exit-codes';
import {
  checkPromptValue,
  parseRunMaxTurns,
  parseRunTimeout,
  parseSessionIdArg,
} from '@kubic/host/run';
import { parseSessionExportFormat } from '@kubic/host/sessions';
import { collect, examples, rule } from '../cli/argv.js';
import type { CommandContext, CommandRegistrar } from '../cli/context.js';

// The `--model` help: one sentence per behaviour the
// flag actually has, no promise the cli layer does not keep.
const MODEL_FLAG_HELP =
  'override the model for this invocation (provider/id; beats env and file, never a frozen enterprise key)';
// The `--thinking` help: one sentence per behaviour the
// flag actually has, no promise the cli layer does not keep.
const THINKING_FLAG_HELP =
  'override the thinking level for this invocation (beats env and file, never a frozen enterprise key)';

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
      'run one headless prompt in this repo (Kubic has no isolation — approvals and the journal are the controls)',
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
      '--pre-approvals <file>',
      'a signed pre-approval file: what this job may run without an ask (checked against [approvals] preApprovalKey; or KUBIC_PRE_APPROVALS)',
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
            ...(opts.preApprovals === undefined
              ? {}
              : { preApprovals: opts.preApprovals }),
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
    .description('open the interactive terminal UI (Kubic has no isolation)')
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

// `sessions fork` and `sessions export`: the two subcommands that copy a
// session out — into a new session, or into a document.
function registerSessionCopies(
  sessions: Command,
  run: (
    invocation: Parameters<CommandContext['runners']['sessions']>[0],
  ) => Promise<void>,
): void {
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
    .command('export')
    .description(
      'print a session as Markdown or HTML: its conversation, tool calls, audit rows and changes, secrets redacted',
    )
    .argument('<id>', 'the session id ([A-Za-z0-9_-])', rule(parseSessionIdArg))
    .option(
      '--format <format>',
      'md (default) or html',
      rule(parseSessionExportFormat),
    )
    .addHelpText(
      'after',
      examples([
        'kubic sessions export <id> > session.md',
        'kubic sessions export <id> --format html > session.html',
      ]),
    )
    .action(async (id, opts) => {
      await run({
        command: 'export',
        id,
        ...(opts.format === undefined ? {} : { format: opts.format }),
      });
    });
}

function registerSessions(program: Command, ctx: CommandContext): void {
  const sessions = program
    .command('sessions')
    .description(
      'list sessions (with no subcommand), or create, attach to, fork, export or prune one',
    )
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
  // A bare `kubic sessions` lists, as `sessions list` does, `--json`
  // included. An unknown subcommand stays a named usage error.
  sessions.action(async (opts, command) => {
    const name = command.args[0];
    if (name === undefined) {
      await run({
        command: 'list',
        ...(opts.json === true ? { json: true } : {}),
      });
      return;
    }
    throw new CliUsageError(
      `unknown command '${name}' (create | list | attach | fork | export | prune)`,
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
  registerSessionCopies(sessions, run);
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
