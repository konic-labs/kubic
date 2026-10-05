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
   * Issue #182: the spill file holding a clipped stream's full text, so the
   * dropped head stays recoverable by path. Names the stdout spill when
   * there is one, else the stderr spill; each clipped stream's own notice
   * names its own file. Absent when nothing was clipped, when the lane gave
   * the op no sink, or when the spill could not be written.
   */
  spillPath?: string;
  /**
   * Which shell actually executed the command — bash is preferred, sh is
   * the recorded fallback (issue #123).
   */
  shell: 'bash' | 'sh' | 'cmd';
  aborted: boolean;
  timedOut: boolean;
  /**
   * Issue #339: present when processes the command backgrounded outlived
   * it — `killed` (the default: the group is reaped when the command
   * exits) or `detached` (KUBIC_BASH_KEEP_BACKGROUND=1 left them running).
   */
  background?: 'killed' | 'detached';
  provenance: Provenance;
}

// Issue #339: a command the model gives no timeout still has one, and a
// model-supplied timeout is clamped to a maximum — a turn can never be
// held open indefinitely by one bash call.
export const BASH_DEFAULT_TIMEOUT_SEC = 120;
export const BASH_MAX_TIMEOUT_SEC = 600;

export interface BashPolicy {
  /** Seconds applied when the model supplies no timeout. */
  defaultTimeoutSec: number;
  /** Upper bound on any timeout, model-supplied or default. */
  maxTimeoutSec: number;
  /** Leave backgrounded jobs running (detached) after the command exits. */
  keepBackground: boolean;
}

export const BASH_POLICY_ENV = {
  defaultTimeoutSec: 'KUBIC_BASH_TIMEOUT',
  maxTimeoutSec: 'KUBIC_BASH_MAX_TIMEOUT',
  keepBackground: 'KUBIC_BASH_KEEP_BACKGROUND',
} as const;

// setTimeout overflows past 2^31-1 ms and would fire at once.
const MAX_TIMER_SEC = 2_147_483;

function positiveSeconds(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !/^\d+(\.\d+)?$/.test(raw.trim()) ||
    !(value > 0) ||
    value > MAX_TIMER_SEC
  ) {
    throw new Error(
      `${name} must be a positive number of seconds (at most ${MAX_TIMER_SEC}), got "${raw}"`,
    );
  }
  return value;
}

/**
 * The documented bash-tool overrides (docs/cli/configuration.md). A
 * malformed value fails closed with the variable named — never a silent
 * fallback to the default.
 */
export function resolveBashPolicy(
  env: Record<string, string | undefined>,
): BashPolicy {
  const maxTimeoutSec = positiveSeconds(
    env,
    BASH_POLICY_ENV.maxTimeoutSec,
    BASH_MAX_TIMEOUT_SEC,
  );
  const defaultTimeoutSec = Math.min(
    positiveSeconds(
      env,
      BASH_POLICY_ENV.defaultTimeoutSec,
      BASH_DEFAULT_TIMEOUT_SEC,
    ),
    maxTimeoutSec,
  );
  const keepRaw = env[BASH_POLICY_ENV.keepBackground];
  let keepBackground = false;
  if (keepRaw !== undefined && keepRaw !== '') {
    if (keepRaw === '1' || keepRaw === 'true') keepBackground = true;
    else if (keepRaw !== '0' && keepRaw !== 'false') {
      throw new Error(
        `${BASH_POLICY_ENV.keepBackground} must be 1/true or 0/false, got "${keepRaw}"`,
      );
    }
  }
  return { defaultTimeoutSec, maxTimeoutSec, keepBackground };
}

function policyFor(ctx: OpContext): BashPolicy {
  if (ctx.bashPolicy !== undefined) return ctx.bashPolicy;
  try {
    return resolveBashPolicy(process.env);
  } catch (error) {
    throw new OpError('tool_failed', (error as Error).message);
  }
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

// …and a line bound on top of it (issue #182; §27.5): pi-durable's
// `DEFAULT_MAX_LINES` is 2000, and a stream of short lines reaches the char
// cap with far more than 2000 of them in view. Whichever bound bites first,
// the TAIL is what stays — and the full stream is spilled by path.
export const BASH_RESULT_MAX_LINES = 2000;

// The last `maxLines` lines of `text` (all of it when it has fewer). A
// trailing newline terminates the last line rather than starting an empty
// one, so 'a\nb\n' with maxLines 1 keeps 'b\n'.
function tailLines(text: string, maxLines: number): string {
  let at = text.endsWith('\n') ? text.length - 1 : text.length;
  for (let seen = 0; seen < maxLines; seen += 1) {
    const nl = text.lastIndexOf('\n', at - 1);
    if (nl === -1) return text;
    at = nl;
  }
  return text.slice(at + 1);
}

interface ClippedStream {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

/**
 * Bound one stream to the tail the model sees, and spill the full text when
 * the lane gave the op a sink (issue #182). A spill that cannot be written
 * is not a failed call: the notice simply names no path.
 */
function clipStream(
  stream: 'stdout' | 'stderr',
  text: string,
  ctx: OpContext,
): ClippedStream {
  const byLines = tailLines(text, BASH_RESULT_MAX_LINES);
  const kept =
    byLines.length > BASH_RESULT_MAX_CHARS
      ? byLines.slice(-BASH_RESULT_MAX_CHARS)
      : byLines;
  if (kept.length === text.length) return { text, truncated: false };
  let spillPath: string | undefined;
  try {
    spillPath = ctx.spill?.write(stream, text);
  } catch {
    spillPath = undefined;
  }
  const notice = `[kubic: ${text.length - kept.length} leading chars dropped${
    spillPath === undefined ? '' : ` — full output: ${spillPath}`
  }]`;
  return {
    text: `${notice}\n${kept}`,
    truncated: true,
    ...(spillPath === undefined ? {} : { spillPath }),
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
// cannot start) as its own anchored line — a bare substring like
// `respawn ENOENT` in user output must not match, and no user-printable
// text (e.g. `bash: not found`) is part of the signature. bash's inner
// `bash: <cmd>: command not found` is a user typo inside a working bash
// and must never match.
const SPAWN_ENOENT_MISSING = /^spawn \S+ ENOENT$/m;

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
  // The limits the model must plan around (issue #339): the default and the
  // ceiling are the shipped constants and the override names come from
  // BASH_POLICY_ENV, so this text cannot drift from them. The description is
  // static (a policy can also arrive per call via OpContext.bashPolicy), so
  // it names the operator overrides instead of claiming the live values. The
  // three variables are not in the worker env allowlist (issue #201), so
  // they reach `kubic run` / `kubic tui` but not orchestrator workers.
  description: `Run a shell command in the workspace root (bash, else sh). Returns the exit code and the raw stdout/stderr under a header; each stream keeps its last 64 KiB. timeout is in seconds (default ${BASH_DEFAULT_TIMEOUT_SEC}, at most ${BASH_MAX_TIMEOUT_SEC}, unless the operator overrides them with ${BASH_POLICY_ENV.defaultTimeoutSec} / ${BASH_POLICY_ENV.maxTimeoutSec} in kubic run or kubic tui); a command that runs past it is killed and the header says "timed out". Jobs the command backgrounds are killed when it ends unless the operator sets ${BASH_POLICY_ENV.keepBackground}=1 (the output says which happened), so do not rely on a server started with & outliving the call.`,
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
    const policy = policyFor(ctx);
    const timeoutSec = Math.min(
      args.timeout ?? policy.defaultTimeoutSec,
      policy.maxTimeoutSec,
    );
    // Issue #142: the unregister fn of whichever handle is currently live.
    let untrack: (() => void) | undefined;
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
        keepBackground: policy.keepBackground,
      });
      // First attempt and any retry both land in the lane's kill registry
      // (issue #11) so timeout/abort kill whichever handle is live — and the
      // settled one leaves it again (issue #142): the registry is reused for
      // a whole session, so a handle left per call was an unbounded leak.
      untrack?.();
      untrack = ctx.trackHandle?.(() => handle.kill(), inv) ?? undefined;
      return handle;
    };
    let shellName = shellFor();
    let live = spawnShell(shellName);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      live.kill();
    }, timeoutSec * 1000);
    const onAbort = () => live.kill();
    if (ctx.signal) {
      if (ctx.signal.aborted) live.kill();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    let result: ShellResult = await live.wait();
    // Issue #123: one-shot detect-and-retry. A 127 settled with the
    // SPAWN-ENOENT signature means this box has no bash binary — env.ts's
    // ENOENT hardening (issue #85) writes Node's `spawn <path> ENOENT`
    // message line to stderr. bash's own inner
    // `bash: <cmd>: command not found` is a user typo inside a working
    // bash and must NOT trigger the retry. Degrade once to sh,
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
    // The live handle has settled: drop its kill from the registry before
    // anything else can retain it (issue #142).
    untrack?.();
    untrack = undefined;
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    const aborted =
      result.exitCode !== 0 && (timedOut || ctx.signal?.aborted === true);
    // Clip AFTER abort/timeout handling: the seam already bounded memory;
    // this bound is the model's context window. The registry's
    // never-replay memoization stores the clipped result — consistent
    // across retries. A clipped stream is spilled by path (issue #182), so
    // the head stays reachable even though the context only carries the
    // tail; `spillPath` names the stdout spill when there is one, else the
    // stderr spill (each stream's own notice names its own file).
    const out = clipStream('stdout', result.stdout, ctx);
    const err = clipStream('stderr', result.stderr, ctx);
    const spillPath = out.spillPath ?? err.spillPath;
    return {
      command: args.command,
      exitCode: aborted ? null : result.exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      ...(spillPath === undefined ? {} : { spillPath }),
      shell: shellName,
      aborted,
      timedOut,
      ...(result.background === undefined
        ? {}
        : { background: result.background }),
      provenance,
    };
  },
};
