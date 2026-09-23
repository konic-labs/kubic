// `kubic git <status|log|commit|stage>` commands (issue #19, slice D; §43.1).
// Thin over the worker git ops; presentation only. Exit 0 on success,
// 1 on usage errors, op failures, or outside-a-repo (with the reason —
// the journal path `kubic diff/undo` keeps working without git).

import type { ExecutionEnv } from '../../exec/src/env.js';
import {
  createInvocation,
  MemoryMemoStore,
} from '../../worker/src/ops/memos.js';
import {
  callOperation,
  OPERATIONS,
  type OperationName,
} from '../../worker/src/ops/registry.js';
import type { OpContext } from '../../worker/src/ops/types.js';

export interface GitCommandDeps {
  env: ExecutionEnv;
  sessionId?: string;
  agentId?: string;
  out: (line: string) => void;
}

export function gitUsage(out: (line: string) => void): number {
  out(
    'usage: kubic git <status [--json] | log [--max <n>] [--json] | stage <path...> | commit -m <message>>',
  );
  return 1;
}

function fail(deps: GitCommandDeps, message: string): number {
  if (message.includes('not a git repository')) {
    deps.out(`not a git repository — kubic diff/undo still work without git`);
    return 1;
  }
  deps.out(`error: ${message}`);
  return 1;
}

export async function runGitCommand(
  args: string[],
  deps: GitCommandDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) return gitUsage(deps.out);
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

  if (sub === 'status') {
    const out = await callOperation('git_status', {}, inv('cli-status'), ctx);
    if (!out.ok) return fail(deps, out.error.message);
    const s = out.result;
    if (rest.includes('--json')) {
      deps.out(JSON.stringify(s, null, 2));
      return 0;
    }
    deps.out(
      `branch ${s.branch}${s.ahead > 0 ? ` (ahead ${s.ahead})` : ''}${s.behind > 0 ? ` (behind ${s.behind})` : ''}`,
    );
    for (const p of s.staged) deps.out(`staged: ${p}`);
    for (const p of s.unstaged) deps.out(`modified: ${p}`);
    for (const p of s.untracked) deps.out(`untracked: ${p}`);
    if (s.clean) deps.out('clean');
    return 0;
  }

  if (sub === 'log') {
    const maxAt = rest.indexOf('--max');
    const max = maxAt === -1 ? undefined : Number(rest[maxAt + 1]);
    if (
      maxAt !== -1 &&
      (max === undefined || !Number.isInteger(max) || max < 1)
    ) {
      deps.out('error: --max needs a positive integer');
      return 1;
    }
    const out = await callOperation(
      'git_log',
      max === undefined ? {} : { max },
      inv('cli-log'),
      ctx,
    );
    if (!out.ok) return fail(deps, out.error.message);
    if (rest.includes('--json')) {
      deps.out(JSON.stringify(out.result.entries, null, 2));
      return 0;
    }
    if (out.result.entries.length === 0) {
      deps.out('no commits');
      return 0;
    }
    for (const e of out.result.entries) {
      deps.out(`${e.sha.slice(0, 8)} ${e.date} ${e.author}: ${e.message}`);
    }
    return 0;
  }

  if (sub === 'stage') {
    const paths = rest.filter((a) => !a.startsWith('--'));
    if (paths.length === 0) {
      deps.out('error: stage needs at least one path');
      return 1;
    }
    const out = await callOperation(
      'git_stage',
      { paths },
      inv('cli-stage'),
      ctx,
    );
    if (!out.ok) return fail(deps, out.error.message);
    for (const p of out.result.staged) deps.out(`staged ${p}`);
    return 0;
  }

  if (sub === 'commit') {
    const mAt = rest.indexOf('-m');
    const message = mAt === -1 ? undefined : rest[mAt + 1];
    if (message === undefined || message === '') {
      deps.out('error: commit needs -m <message>');
      return 1;
    }
    const out = await callOperation(
      'git_commit',
      { message },
      inv('cli-commit'),
      ctx,
    );
    if (!out.ok) return fail(deps, out.error.message);
    deps.out(
      `committed ${out.result.sha.slice(0, 8)} (${out.result.files.length} file(s))`,
    );
    return 0;
  }

  return gitUsage(deps.out);
}

export function gitPushHasNoTool(): boolean {
  return !Object.keys(OPERATIONS).some((name: string) =>
    (name as OperationName).includes('push'),
  );
}
