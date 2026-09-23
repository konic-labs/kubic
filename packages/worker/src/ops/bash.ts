// Bash operation (issue #13, slice D; §9.1).
// Runs through ExecutionEnv.shell: streaming onUpdate, checkpoint store
// under the invocation id, AbortSignal + timeout kill with partial
// snapshots. replay:"never" — execution is an effect; the registry memo
// gate additionally refuses re-invocation under the same invocation id.

import type { Provenance } from '../../../exec/src/env.js';
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
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const shellArgs =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', args.command]
        : ['-c', args.command];
    const handle = ctx.env.shell.spawn(shell, shellArgs, {
      provenance,
      onUpdate: ctx.onUpdate,
      checkpointKey: inv.invocationId,
      checkpointStore: ctx.checkpointStore,
    });
    let timedOut = false;
    const timer =
      args.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            handle.kill();
          }, args.timeout * 1000);
    const onAbort = () => handle.kill();
    if (ctx.signal) {
      if (ctx.signal.aborted) handle.kill();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    const result = await handle.wait();
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    const aborted =
      result.exitCode !== 0 && (timedOut || ctx.signal?.aborted === true);
    return {
      command: args.command,
      exitCode: aborted ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      aborted,
      timedOut,
      provenance,
    };
  },
};
