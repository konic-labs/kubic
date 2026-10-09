// `kubic git <status|log|stage|commit>` commands.
// Thin over the agent git ops; presentation only. commander (the
// composition root, apps/kubic/src/commands/journal.ts) owns argv, help and
// parse errors and hands a typed `GitRequest` here.
//
// Exit codes: 0 success; 1 an op failure or outside-a-repo (thrown as
// CliExitError — one `error:` line on stderr, with the reason; the journal
// path `kubic diff/undo` keeps working without git); 2 a usage error
// (thrown as CliUsageError).

import { createInvocation, MemoryMemoStore } from '@kubic/agent/ops/memos';
import { callOperation } from '@kubic/agent/ops/registry';
import type { OpContext } from '@kubic/agent/ops/types';
import {
  CliExitError,
  CliUsageError,
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import { type CliTheme, createCliTheme } from '@kubic/core/cli/theme';
import type { ExecutionEnv } from '@kubic/exec/env';

export interface GitCommandDeps {
  env: ExecutionEnv;
  sessionId?: string;
  agentId?: string;
  // stdout: the report or the one `--json` document.
  out: (line: string) => void;
  // Report colours (status verdicts, table headers). Default: none; never
  // applied to `--json`.
  theme?: CliTheme;
  // Kit `log` table. Default: plain aligned columns.
  fancy?: boolean;
}

export type GitRequest =
  | { command: 'status'; json?: boolean | undefined }
  | { command: 'log'; max?: number | undefined; json?: boolean | undefined }
  | {
      command: 'stage';
      paths: readonly string[];
      json?: boolean | undefined;
    }
  | { command: 'commit'; message: string; json?: boolean | undefined };

export const GIT_NOT_A_REPO =
  'not a git repository — kubic diff/undo still work without git';

function fail(message: string): never {
  throw new CliExitError(
    EXIT_FAILED,
    message.includes('not a git repository') ? GIT_NOT_A_REPO : message,
  );
}

const PLAIN = createCliTheme('none');

// git's wording for `git log` on a branch with no commits yet.
const UNBORN_BRANCH = /does not have any commits yet/;

const LOG_COLUMNS = [
  { header: 'SHA' },
  { header: 'DATE' },
  { header: 'AUTHOR' },
  { header: 'MESSAGE' },
] as const;

export async function runGitCommand(
  request: GitRequest,
  deps: GitCommandDeps,
): Promise<CommandResult> {
  const json = request.json === true;
  const theme = json ? PLAIN : (deps.theme ?? PLAIN);
  const memos = new MemoryMemoStore();
  const ctx: OpContext = {
    env: deps.env,
    sessionId: deps.sessionId ?? 'cli',
    agentId: deps.agentId ?? 'cli',
  };
  const inv = (id: string): Parameters<typeof callOperation>[2] =>
    createInvocation(
      { invocationId: id, operationId: id, turnId: 't-cli' },
      memos,
    ) as Parameters<typeof callOperation>[2];

  switch (request.command) {
    case 'status': {
      const out = await callOperation('git_status', {}, inv('cli-status'), ctx);
      if (!out.ok) return fail(out.error.message);
      const s = out.result;
      if (json) {
        deps.out(formatJson(s));
        return { exitCode: EXIT_OK };
      }
      deps.out(
        `branch ${theme.bold(s.branch ?? '(detached HEAD)')}${s.ahead > 0 ? ` (ahead ${s.ahead})` : ''}${s.behind > 0 ? ` (behind ${s.behind})` : ''}`,
      );
      for (const p of s.staged) deps.out(`${theme.success('staged:')} ${p}`);
      for (const p of s.unstaged) {
        deps.out(`${theme.warning('modified:')} ${p}`);
      }
      for (const p of s.untracked)
        deps.out(`${theme.muted('untracked:')} ${p}`);
      // Conflicted paths render on their own line — they are
      // resolver work, not staged or modified work.
      for (const p of s.conflicts)
        deps.out(`${theme.error('conflicts:')} ${p}`);
      if (s.clean) deps.out(theme.success('clean'));
      return { exitCode: EXIT_OK };
    }
    case 'log': {
      const max = request.max;
      if (max !== undefined && !(Number.isInteger(max) && max >= 1)) {
        throw new CliUsageError('--max needs a positive integer');
      }
      const out = await callOperation(
        'git_log',
        max === undefined ? {} : { max },
        inv('cli-log'),
        ctx,
      );
      // A fresh repo (unborn branch) has an empty history, not a failure.
      if (!out.ok && !UNBORN_BRANCH.test(out.error.message)) {
        return fail(out.error.message);
      }
      const entries = out.ok ? out.result.entries : [];
      if (json) {
        deps.out(formatJson(entries));
        return { exitCode: EXIT_OK };
      }
      if (entries.length === 0) {
        deps.out('no commits');
        return { exitCode: EXIT_OK };
      }
      const rows = entries.map((e) => [
        theme.warning(e.sha.slice(0, 8)),
        e.date,
        e.author,
        e.message,
      ]);
      const table = renderTable(rows, LOG_COLUMNS, {
        fancy: deps.fancy === true,
        theme,
      });
      for (const line of table.split('\n')) deps.out(line);
      return { exitCode: EXIT_OK };
    }
    case 'stage': {
      if (request.paths.length === 0) {
        throw new CliUsageError('stage needs at least one path');
      }
      const out = await callOperation(
        'git_stage',
        { paths: [...request.paths] },
        inv('cli-stage'),
        ctx,
      );
      if (!out.ok) return fail(out.error.message);
      if (json) {
        deps.out(formatJson(out.result));
        return { exitCode: EXIT_OK };
      }
      for (const p of out.result.staged) {
        deps.out(`${theme.success('staged')} ${p}`);
      }
      return { exitCode: EXIT_OK };
    }
    case 'commit': {
      if (request.message === '') {
        throw new CliUsageError('commit needs a non-empty message (-m)');
      }
      const out = await callOperation(
        'git_commit',
        { message: request.message },
        inv('cli-commit'),
        ctx,
      );
      if (!out.ok) return fail(out.error.message);
      if (json) {
        deps.out(formatJson(out.result));
        return { exitCode: EXIT_OK };
      }
      deps.out(
        `${theme.success('committed')} ${out.result.sha.slice(0, 8)} (${out.result.files.length} file(s))`,
      );
      return { exitCode: EXIT_OK };
    }
  }
}
