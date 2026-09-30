// Pending operations on re-attach (issue #147; §21, §20.7).
//
// A process that dies mid-turn (SIGKILL, OOM, power loss, orphan reaping)
// leaves its lane's operation open in the durable session: Pi restores it on
// the next attach and refuses every new prompt with LaneBusy until it
// settles. §21 says attach resumes the in-flight operation, so this module is
// the one place Kubic decides what happens to it:
//
// - `resume` drives the restored operation to settlement through the same
//   §20.7 loop a fresh prompt uses (a caller may pass a bounded driver — the
//   headless run passes its turn/wall-clock guards). Never-replay tools that
//   were mid-flight are not re-executed: Pi reports them interrupted, and
//   Kubic's memoized results answer a replayed invocation id.
// - `abort` durably requests the abort (recorded in-session, kill registry
//   drained) and drives the operation to its `aborted` settlement.
//
// A resume that cannot settle — it suspends on a deferred approval, or its
// driver throws (a guard fired, the drive failed) — falls back to the
// durable abort, so the lane is always free for the next prompt afterwards.

import type {
  AgentLane,
  Context,
  OpenOperation,
  OperationResultRecord,
  Session,
} from '../pi-boundary.js';
import { AgentHarness, createModels } from '../pi-boundary.js';
import { type OperationKillRegistry, requestLaneAbort } from './abort.js';
import { driveToSettled, type SettledDrive } from './solo.js';

export type PendingPolicy = 'resume' | 'abort';

export interface PendingSettlement {
  operationId: string;
  kind: OpenOperation['kind'];
  startedAt: number;
  // What Kubic did with the operation.
  action: 'resumed' | 'aborted';
  // The lane's own terminal status for it (completed / failed / aborted…).
  status: string;
  // Why a resume fell back to the abort, when it did.
  reason?: string;
}

export interface PendingLane {
  lane: Pick<AgentLane, 'drive' | 'requestAbort'>;
  kills: OperationKillRegistry;
}

export type PendingDriver = (operationId: string) => Promise<SettledDrive>;

function statusOf(drive: SettledDrive): string {
  if (drive.kind !== 'settled') return 'suspended';
  const record = drive.outcome as Partial<OperationResultRecord> | null;
  return typeof record?.status === 'string' ? record.status : 'settled';
}

async function abortToSettled(
  solo: PendingLane,
  op: OpenOperation,
  context: Context,
): Promise<string> {
  if (op.aborting !== true) {
    await requestLaneAbort(solo.lane, solo.kills, op.operationId, context);
  }
  return statusOf(await driveToSettled(solo.lane, op.operationId, context));
}

export async function settlePendingOperation(
  solo: PendingLane,
  op: OpenOperation,
  policy: PendingPolicy,
  context: Context,
  drive: PendingDriver = (operationId) =>
    driveToSettled(solo.lane, operationId, context),
): Promise<PendingSettlement> {
  const base = {
    operationId: op.operationId,
    kind: op.kind,
    startedAt: op.startedAt,
  };
  // An abort the dead process already requested is honoured as an abort:
  // the operator's cancel outlives the crash.
  if (policy === 'abort' || op.aborting === true) {
    return {
      ...base,
      action: 'aborted',
      status: await abortToSettled(solo, op, context),
    };
  }
  let reason: string;
  try {
    const driven = await drive(op.operationId);
    if (driven.kind === 'settled') {
      return { ...base, action: 'resumed', status: statusOf(driven) };
    }
    reason = 'suspended waiting on an approval';
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return {
    ...base,
    action: 'aborted',
    status: await abortToSettled(solo, op, context),
    reason,
  };
}

// The line `kubic sessions attach` prints for an open operation.
export function describePendingOperation(op: OpenOperation): string {
  return `pending operation: ${op.operationId} (${op.kind}, started ${new Date(
    op.startedAt,
  ).toISOString()}${op.aborting === true ? ', abort requested' : ''})`;
}

// `pending operation <id> (<kind>, started <iso>)` — the head every
// pending-op line shares.
export function pendingHead(
  op: Pick<OpenOperation, 'operationId' | 'kind' | 'startedAt'>,
): string {
  return `pending operation ${op.operationId} (${op.kind}, started ${new Date(
    op.startedAt,
  ).toISOString()})`;
}

// The one-line outcome run (stderr) and tui (footer) report.
export function describeSettlement(settled: PendingSettlement): string {
  const head = pendingHead(settled);
  if (settled.action === 'resumed') {
    return `${head} resumed after an interrupted run: ${settled.status}`;
  }
  return settled.reason === undefined
    ? `${head} aborted after an interrupted run`
    : `${head} aborted after an interrupted run (resume could not settle: ${settled.reason})`;
}

// Read-only probe for `kubic sessions attach`: Pi restores every lane's
// operation state when a harness attaches, and reports the open ones. No
// lane is acquired and nothing is written — the model registry is empty and
// the placeholder model is never resolved.
export async function inspectOpenOperations(
  session: Session,
  context: Context,
): Promise<OpenOperation[]> {
  const { open } = await AgentHarness.create(
    {
      session,
      models: createModels(),
      model: { provider: 'kubic-inspect', id: 'kubic-inspect' } as never,
      tools: [],
    },
    context,
  );
  return open;
}

// The text of the newest user message on the lane: the prompt an open run
// operation was admitted with (Pi commits the prompt entry at admission).
export function lastUserPromptText(
  entries: readonly unknown[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    } | null;
    if (entry?.type !== 'message' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          (part as { type?: unknown })?.type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('');
  }
  return undefined;
}
