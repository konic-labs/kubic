// Running the admin hooks: before a tool call (a refusal or a timeout blocks
// the call), after it, and when a run ends. Each hook gets the event as JSON
// on stdin, runs in the tool environment (no provider key) in the workspace,
// and every run is audited. A before-tool hook allows the call only with a
// zero exit inside its bound: anything else refuses it, naming the hook and
// its reason, the first line it printed.

import { redactSecrets } from '@kubic/core/secret-shapes';
import { type HookRun, runHookCommand } from '@kubic/exec/hook-runner';
import {
  appendToLedger,
  auditLedgerDirFor,
  hookRunAudit,
} from '../audit/index.js';
import type { AdminHook, HookEvent } from '../config/index.js';

const OUTPUT_IN_PAYLOAD = 64 * 1024;

export interface HookContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly model?: string;
  // Where audit failures go (the ledger never blocks a hook's verdict).
  readonly onAuditError?: (message: string) => void;
  // The hook runner (tests); absent: the exec one.
  readonly run?: typeof runHookCommand;
}

function applies(hook: AdminHook, event: HookEvent, tool?: string): boolean {
  if (hook.event !== event) return false;
  if (tool === undefined || hook.tools === undefined) return true;
  return hook.tools.includes(tool);
}

// The reason a hook gives: the first line it printed (stdout, else stderr),
// bounded and redacted.
function reasonOf(run: HookRun): string | undefined {
  const line = [run.stdout, run.stderr]
    .flatMap((text) => text.split('\n'))
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  return line === undefined ? undefined : redactSecrets(line.slice(0, 200));
}

async function runOne(
  hook: AdminHook,
  payload: Record<string, unknown>,
  ctx: HookContext,
): Promise<{ ok: boolean; reason: string }> {
  const run = await (ctx.run ?? runHookCommand)(
    hook.command,
    JSON.stringify(payload),
    {
      timeoutMs: hook.timeoutMs,
      cwd: ctx.workspace,
      env: { KUBIC_HOOK_EVENT: hook.event },
    },
  );
  if (run.timedOut) {
    return {
      ok: false,
      reason: `the hook did not answer within ${hook.timeoutMs} ms`,
    };
  }
  if (run.error !== undefined) {
    return { ok: false, reason: `the hook could not start: ${run.error}` };
  }
  if (run.exitCode !== 0) {
    return {
      ok: false,
      reason: reasonOf(run) ?? `the hook exited ${String(run.exitCode)}`,
    };
  }
  return { ok: true, reason: reasonOf(run) ?? 'ok' };
}

function audit(
  ctx: HookContext,
  hook: AdminHook,
  result: 'ok' | 'deny' | 'error',
  reason: string,
  tool?: string,
): void {
  appendToLedger(
    auditLedgerDirFor(ctx.workspace),
    hookRunAudit({
      sessionId: ctx.sessionId,
      workspace: ctx.workspace,
      event: hook.event,
      command: hook.command,
      ...(tool === undefined ? {} : { tool }),
      result,
      reason,
    }),
    ctx.onAuditError,
  );
}

/** Runs the before-tool hooks in order; the refusal of the first that refuses. */
export async function runBeforeToolHooks(
  hooks: readonly AdminHook[],
  call: { readonly tool: string; readonly arguments: unknown },
  ctx: HookContext,
): Promise<string | undefined> {
  for (const hook of hooks) {
    if (!applies(hook, 'beforeTool', call.tool)) continue;
    const outcome = await runOne(
      hook,
      {
        event: 'beforeTool',
        sessionId: ctx.sessionId,
        workspace: ctx.workspace,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        tool: { name: call.tool, arguments: call.arguments },
      },
      ctx,
    );
    audit(ctx, hook, outcome.ok ? 'ok' : 'deny', outcome.reason, call.tool);
    if (!outcome.ok) {
      return `refused by the hook ${JSON.stringify(hook.command)}: ${outcome.reason}`;
    }
  }
  return undefined;
}

/** Runs the after-tool hooks; they observe, and never change the result. */
export async function runAfterToolHooks(
  hooks: readonly AdminHook[],
  call: {
    readonly tool: string;
    readonly arguments: unknown;
    readonly isError: boolean;
    readonly output: string;
  },
  ctx: HookContext,
): Promise<void> {
  for (const hook of hooks) {
    if (!applies(hook, 'afterTool', call.tool)) continue;
    const outcome = await runOne(
      hook,
      {
        event: 'afterTool',
        sessionId: ctx.sessionId,
        workspace: ctx.workspace,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        tool: {
          name: call.tool,
          arguments: call.arguments,
          isError: call.isError,
          output: call.output.slice(0, OUTPUT_IN_PAYLOAD),
        },
      },
      ctx,
    );
    audit(ctx, hook, outcome.ok ? 'ok' : 'error', outcome.reason, call.tool);
  }
}

/** Runs the run-end hooks with how the run ended. */
export async function runRunEndHooks(
  hooks: readonly AdminHook[],
  // The summary is the run's final answer; a TUI turn has none to give.
  run: { readonly status: string; readonly summary?: string },
  ctx: HookContext,
): Promise<void> {
  for (const hook of hooks) {
    if (!applies(hook, 'runEnd')) continue;
    const outcome = await runOne(
      hook,
      {
        event: 'runEnd',
        sessionId: ctx.sessionId,
        workspace: ctx.workspace,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        status: run.status,
        ...(run.summary === undefined
          ? {}
          : { summary: run.summary.slice(0, OUTPUT_IN_PAYLOAD) }),
      },
      ctx,
    );
    audit(ctx, hook, outcome.ok ? 'ok' : 'error', outcome.reason);
  }
}
