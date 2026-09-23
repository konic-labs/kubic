// Lane abort with kill tree (issue #11, slice C). requestAbort is durable:
// the harness records the operation_abort event in-session, so a crashed
// host re-reads cancel_requested instead of re-driving a dead run. The
// kill registry drains in-flight op processes (bash hands its detached
// group kill over via OpContext.trackHandle); every kill is attempted even
// when one throws, and failures aggregate into one LaneDriveError.

import type { Context } from '../pi-boundary.js';
import { LaneDriveError } from './solo.js';

export type KillFn = () => void;

export class OperationKillRegistry {
  private readonly kills = new Map<string, KillFn[]>();

  track(operationId: string, kill: KillFn): void {
    const existing = this.kills.get(operationId) ?? [];
    existing.push(kill);
    this.kills.set(operationId, existing);
  }

  drain(operationId: string): KillFn[] {
    const kills = this.kills.get(operationId) ?? [];
    this.kills.delete(operationId);
    return kills;
  }
}

export interface LaneAborter {
  requestAbort(
    operationId: string,
    context: Context,
  ): Promise<
    | { ok: true; value: { operationId: string; newlyRequested: boolean } }
    | { ok: false; error: unknown }
  >;
}

export interface LaneAbortResult {
  newlyRequested: boolean;
  killed: number;
}

export async function requestLaneAbort(
  lane: LaneAborter,
  kills: OperationKillRegistry,
  operationId: string,
  context: Context,
): Promise<LaneAbortResult> {
  const requested = await lane.requestAbort(operationId, context);
  if (!requested.ok) {
    // Intentional: kills stay tracked so a retried abort still drains them.
    // Draining here would either leak (never killed) or kill processes for
    // an operation the harness refused to stop.
    const detail =
      requested.error instanceof Error
        ? requested.error.message
        : JSON.stringify(requested.error);
    throw new LaneDriveError(`lane abort failed for ${operationId}: ${detail}`);
  }
  let killed = 0;
  const failures: string[] = [];
  for (const kill of kills.drain(operationId)) {
    try {
      kill();
      killed += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new LaneDriveError(
      `lane abort kills failed for ${operationId}: ${failures.join('; ')}`,
    );
  }
  return { newlyRequested: requested.value.newlyRequested, killed };
}
