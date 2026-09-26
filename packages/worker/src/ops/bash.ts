// Bash operation (issue #13, slice D; §9.1).
// Runs through ExecutionEnv.shell: streaming onUpdate, checkpoint store
// under the invocation id, AbortSignal + timeout kill with partial
// snapshots. replay:"never" — execution is an effect; the registry memo
// gate additionally refuses re-invocation under the same invocation id.

import type {
  ProcessHandle,
  Provenance,
  ShellResult,
} from '../../../exec/src/env.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface BashArgs {
  command: string;
  timeout?: number;
}

export interface BashResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * True when either stream was clipped to the model-facing cap — the
   * result names the dropped leading chars in a header, and the model
   * knows it saw a slice (issue #121).
   */
  truncated: boolean;
  /**
   * Which shell actually executed the command — bash is preferred, sh is
   * the recorded fallback (issue #123).
   */
  shell: 'bash' | 'sh' | 'cmd';
  aborted: boolean;
  timedOut: boolean;
  provenance: Provenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBashArgs(raw: unknown): BashArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'bash args must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'command' && key !== 'timeout') {
      throw new OpError(
        'invalid_args',
        `bash: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    throw new OpError(
      'invalid_args',
      'bash: command must be a non-empty string',
    );
  }
  if (
    raw.timeout !== undefined &&
    (typeof raw.timeout !== 'number' ||
      !Number.isFinite(raw.timeout) ||
      raw.timeout <= 0)
  ) {
    throw new OpError(
      'invalid_args',
      'bash: timeout must be a positive number of seconds',
    );
  }
  return { command: raw.command, timeout: raw.timeout as number | undefined };
}

function turnNumber(turnId: string): number {
  const match = turnId.match(/(\d+)$/);
  return match ? Number.parseInt(match[1] as string, 10) : 0;
}

// Model-facing cap per stream (issue #121): chars, not bytes — this is a
// context-window bound. One grep over a big file must not dump megabytes
// into the model's window; the harness has compaction, but the tool
// result itself should never be the thing that blows it.
export const BASH_RESULT_MAX_CHARS = 64 * 1024;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= BASH_RESULT_MAX_CHARS) return { text, truncated: false };
  return {
    text: `[kubic: ${text.length - BASH_RESULT_MAX_CHARS} leading chars dropped]\n${text.slice(-BASH_RESULT_MAX_CHARS)}`,
    truncated: true,
  };
}

// Issue #123: the tool is named bash and the prompts say bash — run bash
// when the system has it. Resolution is lazy and cached per process: the
// first command attempts bash, and the exit-127 detect-and-retry inside
// execute() (below) records 'sh' when bash is missing. Detection goes
// through the SAME seam the command runs through (ctx.env.shell) — a fake
// env scripts its answer; no op touches child_process.

// Spawn-ENOENT signature only: Node's `spawn <path> ENOENT` message (what
// env.ts's issue #85 hardening writes to stderr when the bash BINARY
// cannot start), plus the bare `bash: not found` shape the tests script
// for the same failure. bash's inner `bash: <cmd>: command not found` is
// a user typo inside a working bash and must never match.
const SPAWN_ENOENT_MISSING = /spawn .*ENOENT|^bash: not found$/im;

let resolvedShell: BashResult['shell'] | undefined;

function shellFor(): BashResult['shell'] {
  if (process.platform === 'win32') return 'cmd';
  if (resolvedShell === undefined) resolvedShell = 'bash';
  return resolvedShell;
}

/** Test seam (never re-exported): pin or reset the per-process resolution. */
export function __setResolvedShellForTests(
  shell: BashResult['shell'] | undefined,
): void {
  resolvedShell = shell;
}

export const bashOperation: Operation<BashArgs, BashResult> = {
  name: 'bash',
  description: 'Execute a shell command with streaming, timeout, and abort',
  replay: 'never',
  validateArgs: validateBashArgs,
  execute: async (inv: ToolInvocation, args: BashArgs, ctx: OpContext) => {
    const provenance: Provenance = {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: inv.invocationId,
      turnId: turnNumber(inv.turnId),
      operation: 'bash',
    };
    const spawnShell = (shellName: string): ProcessHandle => {
      const shellArgs =
        process.platform === 'win32'
          ? ['/d', '/s', '/c', args.command]
          : ['-c', args.command];
      const handle = ctx.env.shell.spawn(shellName, shellArgs, {
        provenance,
        onUpdate: ctx.onUpdate,
        checkpointKey: inv.invocationId,
        checkpointStore: ctx.checkpointStore,
      });
      // First attempt and any retry both land in the lane's kill registry
      // (issue #11) so timeout/abort kill whichever handle is live.
      ctx.trackHandle?.(() => handle.kill(), inv);
      return handle;
    };
    let shellName = shellFor();
    let live = spawnShell(shellName);
    let timedOut = false;
    const timer =
      args.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            live.kill();
          }, args.timeout * 1000);
    const onAbort = () => live.kill();
    if (ctx.signal) {
      if (ctx.signal.aborted) live.kill();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    let result: ShellResult = await live.wait();
    // Issue #123: one-shot detect-and-retry. A 127 settled with the
    // SPAWN-ENOENT signature means this box has no bash binary — env.ts's
    // ENOENT hardening (issue #85) writes Node's `spawn <path> ENOENT`
    // message to stderr (tests script the `bash: not found` shape). bash's
    // own inner `bash: <cmd>: command not found` is a user typo inside a
    // working bash and must NOT trigger the retry. Degrade once to sh,
    // remember the answer for the process, and never loop. This runs
    // inside execute — before the registry memoizes the result under
    // `op-result-bash` — so a retried command memoizes exactly once.
    if (
      result.exitCode === 127 &&
      shellName === 'bash' &&
      !timedOut &&
      ctx.signal?.aborted !== true &&
      SPAWN_ENOENT_MISSING.test(result.stderr)
    ) {
      resolvedShell = 'sh';
      shellName = 'sh';
      // The retry reuses the original timeout window (the timer is not
      // reset) — its effective budget is whatever remains of args.timeout.
      live = spawnShell(shellName);
      result = await live.wait();
    }
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    const aborted =
      result.exitCode !== 0 && (timedOut || ctx.signal?.aborted === true);
    // Clip AFTER abort/timeout handling: the seam already bounded memory;
    // this bound is the model's context window. The registry's
    // never-replay memoization stores the clipped result — consistent
    // across retries.
    const out = clip(result.stdout);
    const err = clip(result.stderr);
    return {
      command: args.command,
      exitCode: aborted ? null : result.exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      shell: shellName,
      aborted,
      timedOut,
      provenance,
    };
  },
};
