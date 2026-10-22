// Running git for the git operations: one bounded child process, the
// not-a-repo error, and the capped `--stat` summary the writes report.

import type { OpContext, ToolInvocation } from '../types.js';
import { OpError } from '../types.js';

export interface GitRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Kill bound for git children: a commit hook that blocks on
// stdin must never hang the op forever. Same ceiling as bash (120s
// default, 600s max); unlike bash there is no model timeout argument (git
// argument contracts are frozen), so the default always applies unless a
// direct runGit caller passes its own.
const GIT_DEFAULT_TIMEOUT_SEC = 120;
const GIT_MAX_TIMEOUT_SEC = 600;

export interface GitRunOptions {
  /** Seconds before the child is killed; clamped to GIT_MAX_TIMEOUT_SEC. */
  timeoutSec?: number;
}

export function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/**
 * Spawn git through the shell seam with lane abort + timeout wired like
 * bash: the kill lands in the lane's kill registry under
 * this invocation and leaves it once settled; the timeout or
 * an aborted signal kills the child. Throws `tool_failed` on timeout, or
 * on abort when the child did not exit cleanly — every other exit comes
 * back for the op to classify (not_a_repo, reason-bounded tool_failed).
 */
export async function runGit(
  ctx: OpContext,
  inv: ToolInvocation,
  operation: string,
  args: string[],
  options?: GitRunOptions,
): Promise<GitRun> {
  const handle = ctx.env.shell.spawn('git', args, {
    provenance: {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: 0,
      operation,
    },
    onUpdate: ctx.onUpdate,
  });
  const untrack = ctx.trackHandle?.(() => handle.kill(), inv);
  const timeoutSec = Math.min(
    options?.timeoutSec ?? GIT_DEFAULT_TIMEOUT_SEC,
    GIT_MAX_TIMEOUT_SEC,
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    handle.kill();
  }, timeoutSec * 1000);
  const onAbort = () => handle.kill();
  if (ctx.signal !== undefined) {
    if (ctx.signal.aborted) handle.kill();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  }
  // The untrack, timer clear and listener removal sit in a
  // finally — a rejecting wait() must not leak the timer or the registry
  // entry (bash parity).
  let done: Awaited<ReturnType<typeof handle.wait>>;
  try {
    done = await handle.wait();
  } finally {
    untrack?.();
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
  // bash parity: a success that won the race against the abort stays a
  // success; anything else the interruption touched is a named failure.
  if (timedOut) {
    throw new OpError(
      'tool_failed',
      `git ${operation} timed out after ${timeoutSec} seconds`,
    );
  }
  if (done.exitCode !== 0 && ctx.signal?.aborted === true) {
    throw new OpError('tool_failed', `git ${operation} aborted`);
  }
  return {
    exitCode: done.exitCode,
    stdout: done.stdout,
    stderr: done.stderr,
    timedOut,
  };
}

// Maximum --stat lines carried inline on a clipped result:
// the file rows that fit plus the `N files changed` summary, so the model
// knows what the clip dropped without re-inflating to the clipped size.
const STAT_MAX_LINES = 40;

function capStat(out: string): string {
  const lines = out.split('\n').filter((line) => line !== '');
  if (lines.length <= STAT_MAX_LINES) return lines.join('\n');
  const summary = lines[lines.length - 1] ?? '';
  const kept = lines.slice(0, STAT_MAX_LINES - 1);
  return [
    ...kept,
    `... (${lines.length - kept.length - 1} more stat lines)`,
    summary,
  ].join('\n');
}

// Best-effort `--stat` twin of a clipped query: undefined
// when the stat query itself fails, so a summary can never fail the op —
// a twin timeout or abort-throw degrades the same way as a non-zero exit.
export async function gitStatSummary(
  ctx: OpContext,
  inv: ToolInvocation,
  operation: string,
  statArgs: string[],
): Promise<string | undefined> {
  try {
    const run = await runGit(ctx, inv, operation, statArgs);
    if (run.exitCode !== 0) return undefined;
    const capped = capStat(run.stdout);
    return capped === '' ? undefined : capped;
  } catch {
    return undefined;
  }
}

export function notARepoError(op: string, stderr: string): OpError {
  return new OpError(
    'not_a_repo',
    `${op}: unavailable — not a git repository (${stderr.trim().slice(0, 120)}). Journal diff/undo still work without git.`,
  );
}
