// Change-journal commands (VCS-independent): diff, undo, log, status, the
// journal prune command, plus the git helper. Registered on the root program
// by ../dispatch.ts.
//
// commander owns the whole argv surface here — options, operands, generated
// `--help`, and parse errors (exit 2, docs/cli/exit-codes.md). Each action
// hands a typed request to the injected runner (production wiring in
// ../prod-runners.ts → packages/host/src/{journal,git}-cli.ts), which
// returns the command's exit code.

import { InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { CliUsageError } from '../../../../packages/core/src/cli/exit-codes.js';
import type { GitRequest } from '../../../../packages/host/src/git-cli.js';
import type { JournalRequest } from '../../../../packages/host/src/journal-cli.js';
import type {
  CommandContext,
  CommandRegistrar,
  KubicProgram,
} from '../cli/context.js';

// `--max-content-bytes <n>`: 0 means unlimited.
function parseNonNegativeInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      'needs a non-negative integer (0 = unlimited)',
    );
  }
  return Number(value);
}

// `git log --max <n>`.
function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError('--max needs a positive integer');
  }
  return Number(value);
}

// `journal prune --keep-days <n>`: a non-negative integer of days (0 = off).
function parseKeepDays(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError('needs a non-negative integer of days');
  }
  return Number(value);
}

// The store selector every journal command shares (fresh per command:
// commander options belong to one command).
function sessionOption(
  help = 'read the run session journal <id> (or the journal:<id> ref `kubic run` prints)',
) {
  return new Option('--session <id>', help);
}

function jsonOption() {
  return new Option('--json', 'print one JSON document on stdout');
}

const DIFF_HELP = `
Store: --session <id> (paths resolve in that session's recorded workspace),
else <cwd>/.kubic/journal, else the latest session journal recorded for this
workspace (named on stderr).

Examples:
  $ kubic diff                         # every journaled change, as a diff
  $ kubic diff src/app.ts              # one file (same as --path)
  $ kubic diff --stat                  # per-file summary instead of hunks
  $ kubic diff --session journal:abc   # the run that printed journal:abc
  $ kubic diff --json --max-content-bytes 0   # unclipped JSON`;

const UNDO_HELP = `
Exit 1 when any step was skipped (non-reversible, stale, already undone);
--json names each skipped path, kind and reason.

Examples:
  $ kubic undo --dry-run          # show what would be restored
  $ kubic undo                    # restore every journaled change
  $ kubic undo --step             # restore the last step only (again = redo)
  $ kubic undo -- src/app.ts      # restore one path`;

const GIT_HELP = `
Outside a git repository every subcommand exits 1 — the journal commands
(diff, undo, log, status) keep working without git.

Examples:
  $ kubic git status
  $ kubic git log --max 5
  $ kubic git stage -- src/app.ts
  $ kubic git commit -m "fix: handle empty input"`;

const GIT_SUBCOMMANDS = 'status | log | stage | commit';

const JOURNAL_HELP = `
Prune removes entries older than the keep window from the journal \`kubic log\`
reads: --session <id>, else this workspace's journal. A dry run unless --yes.
An unknown session and a session attached to a live run are refused. --yes
also sweeps blob files that no remaining entry references, but only as part of
a pass that drops entries: with nothing to prune, orphan blobs stay. The dry
run lists entries only; the reclaimed figure counts the swept bytes.

Examples:
  $ kubic journal prune --keep-days 30
  $ kubic journal prune --session 3f2a --keep-days 30 --yes`;

const JOURNAL_SUBCOMMANDS = 'prune';

export const registerJournalCommands: CommandRegistrar = (program, ctx) => {
  const journal = async (request: JournalRequest): Promise<void> => {
    ctx.finish(await ctx.runners.journal(request, ctx.config));
  };

  program
    .command('diff')
    .description('show journaled changes as a unified diff')
    // The path operand scopes exactly like `--path` (spec
    // `kubic diff <path>`); without the declaration commander dropped
    // the operand as excess, so users believed the diff was scoped when it
    // was not. A second operand is commander's own too-many-arguments
    // refusal, the same as `undo`.
    .argument(
      '[path]',
      'only changes to this path (same as --path; use -- before a path starting with -)',
    )
    .option('--path <path>', 'only changes to this path')
    .option('--stat', 'per-file summary instead of hunks')
    .option(
      '--max-content-bytes <n>',
      '--json: clip each side of a change at <n> bytes (default 65536, 0 = unlimited)',
      parseNonNegativeInt,
    )
    .addOption(sessionOption())
    .addOption(jsonOption())
    .addHelpText('after', DIFF_HELP)
    .action(async (operandPath, opts) => {
      if (
        operandPath !== undefined &&
        opts.path !== undefined &&
        operandPath !== opts.path
      ) {
        throw new CliUsageError(
          `--path '${opts.path}' conflicts with path operand '${operandPath}' — give one path`,
        );
      }
      await journal({
        command: 'diff',
        ...opts,
        ...(operandPath === undefined ? {} : { path: operandPath }),
      });
    });

  program
    .command('undo')
    .description('restore journaled changes (verified against the journal)')
    .argument(
      '[path]',
      'only undo changes to this path (use -- before a path starting with -)',
    )
    .option('--step', 'restore the most recent step only')
    .option('--dry-run', 'print what would be restored; change nothing')
    .option('--force', 'restore over stale files (changed since journaled)')
    .addOption(sessionOption())
    .addOption(jsonOption())
    .addHelpText('after', UNDO_HELP)
    .action(async (path, opts) =>
      journal({
        command: 'undo',
        ...opts,
        ...(path === undefined ? {} : { path }),
      }),
    );

  program
    .command('log')
    .description('list journaled steps, oldest first')
    .addOption(sessionOption())
    .addOption(jsonOption())
    .action(async (opts) => journal({ command: 'log', ...opts }));

  program
    .command('status')
    .description('summarize the journal and the repo state')
    .addOption(sessionOption())
    .addOption(jsonOption())
    .action(async (opts) => journal({ command: 'status', ...opts }));

  registerJournalGroup(program, ctx);
  registerGit(program, ctx);
};

function registerJournalGroup(
  program: KubicProgram,
  ctx: CommandContext,
): void {
  const journal = async (request: JournalRequest): Promise<void> => {
    ctx.finish(await ctx.runners.journal(request, ctx.config));
  };

  const group = program
    .command('journal')
    .description('prune the change journal (explicit; a dry run unless --yes)')
    .addHelpText('after', JOURNAL_HELP)
    // The group declares no operand, so `prune` is listed once, under
    // Commands. A bare `kubic journal` or an unknown subcommand is still a
    // usage error (exit 2), never commander's help-on-error or unknown-command
    // exit 1 — the same shape `kubic sessions` uses.
    .allowExcessArguments()
    .action((_options, command) => {
      const name = command.args[0];
      throw new CliUsageError(
        name === undefined
          ? `journal needs a subcommand (${JOURNAL_SUBCOMMANDS})`
          : `unknown journal subcommand '${name}' (${JOURNAL_SUBCOMMANDS})`,
      );
    });

  group
    .command('prune')
    .description(
      'delete journal entries older than the keep window (a dry run unless --yes)',
    )
    // Commander copies the group's excess-operand setting to its subcommands;
    // prune takes no operand, so `prune <stray>` stays a usage error.
    .allowExcessArguments(false)
    .addOption(
      sessionOption(
        'prune the run session journal <id> (or the journal:<id> ref `kubic run` prints)',
      ),
    )
    .option(
      '--keep-days <n>',
      'keep entries younger than n days (default: [journal] retentionDays, or KUBIC_JOURNAL_RETENTION_DAYS)',
      parseKeepDays,
    )
    .option('--yes', 'delete the entries (without it, only list them)')
    .addOption(jsonOption())
    .action(async (opts) => journal({ command: 'prune', ...opts }));
}

function registerGit(program: KubicProgram, ctx: CommandContext): void {
  const git = async (request: GitRequest): Promise<void> => {
    ctx.finish(await ctx.runners.git(request, ctx.config));
  };

  const group = program
    .command('git')
    .description('git helpers over the workspace repository')
    .usage('<subcommand> [options]')
    .addHelpText('after', GIT_HELP)
    // A bare `kubic git` or an unknown subcommand is a usage error (exit
    // 2), never commander's help-on-error or unknown-command exit 1.
    .argument('[subcommand]', GIT_SUBCOMMANDS)
    .action((name) => {
      throw new CliUsageError(
        name === undefined
          ? `git needs a subcommand (${GIT_SUBCOMMANDS})`
          : `unknown git subcommand '${name}' (${GIT_SUBCOMMANDS})`,
      );
    });

  group
    .command('status')
    .description('branch, ahead/behind, and staged/modified/untracked paths')
    .addOption(jsonOption())
    .action(async (opts) => git({ command: 'status', ...opts }));

  group
    .command('log')
    .description('recent commits, newest first')
    .option('--max <n>', 'at most <n> commits', parsePositiveInt)
    .addOption(jsonOption())
    .action(async (opts) => git({ command: 'log', ...opts }));

  group
    .command('stage')
    .description('stage paths for the next commit')
    .argument(
      '<paths...>',
      'paths to stage (use -- before a path starting with -)',
    )
    .addOption(jsonOption())
    .action(async (paths, opts) => git({ command: 'stage', paths, ...opts }));

  group
    .command('commit')
    .description('commit the staged changes')
    .requiredOption(
      '-m, --message <message>',
      'the commit message (taken verbatim, even when it starts with -)',
    )
    .addOption(jsonOption())
    .action(async (opts) => {
      if (opts.message === '') {
        throw new CliUsageError('commit needs a non-empty message (-m)');
      }
      await git({ command: 'commit', ...opts });
    });

  // The top-level alias — `kubic commit -m <message>` is
  // `kubic git commit`, same runner, message rule and exit codes.
  program
    .command('commit')
    .description('commit the staged changes (same as `kubic git commit`)')
    .requiredOption(
      '-m, --message <message>',
      'the commit message (taken verbatim, even when it starts with -)',
    )
    .addOption(jsonOption())
    .addHelpText(
      'after',
      `
Examples:
  $ kubic commit -m "fix: handle empty input"
  $ kubic commit -m "wip" --json`,
    )
    .action(async (opts) => {
      if (opts.message === '') {
        throw new CliUsageError('commit needs a non-empty message (-m)');
      }
      await git({ command: 'commit', ...opts });
    });
}
