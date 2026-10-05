// Change-journal commands (VCS-independent): diff, undo, log, status, plus
// the git helper. Registered on the root program by ../dispatch.ts.
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
export function parseNonNegativeInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      'needs a non-negative integer (0 = unlimited)',
    );
  }
  return Number(value);
}

// `git log --max <n>`.
export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError('--max needs a positive integer');
  }
  return Number(value);
}

// The store selector every journal command shares (fresh per command:
// commander options belong to one command).
function sessionOption() {
  return new Option(
    '--session <id>',
    'read the run session journal <id> (or the journal:<id> ref `kubic run` prints)',
  );
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

export const registerJournalCommands: CommandRegistrar = (program, ctx) => {
  const journal = async (request: JournalRequest): Promise<void> => {
    ctx.setExitCode(await ctx.runners.journal(request, ctx.config));
  };

  program
    .command('diff')
    .description('show journaled changes as a unified diff')
    // Issue #271: the path operand scopes exactly like `--path` (spec
    // §42.2 `kubic diff <path>`); without the declaration commander dropped
    // the operand as excess, so users believed the diff was scoped when it
    // was not. A second operand is commander's own too-many-arguments
    // refusal, the same as `undo`.
    .argument(
      '[path]',
      'only changes to this path (same as --path; use -- before a path starting with -)',
    )
    .option('--path <path>', 'only changes to this path')
    .option('--stat', 'per-file summary instead of hunks')
    .option('--agent <id>', 'only changes made by this agent')
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

  registerGit(program, ctx);
};

function registerGit(program: KubicProgram, ctx: CommandContext): void {
  const git = async (request: GitRequest): Promise<void> => {
    ctx.setExitCode(await ctx.runners.git(request, ctx.config));
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

  // Issue #268 (§17): the top-level alias — `kubic commit -m <message>` is
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
