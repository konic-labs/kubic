// Lane abort with kill tree (issue #11 slice C; ported to pi-durable in
// #395). `conversation.abort(context)` is the durable stop: it withdraws
// queued inputs, marks every live task of the conversation's ordinary scope,
// signals them, and resolves once the scope is idle (README "Abort and
// Subagents"). Kubic's bash children run in detached process groups, so the
// harness's own cancellation cannot reach them: every such child is tracked
// in the lane's OperationKillRegistry under its conversation id (D1) and is
// killed here.
//
// Order matters: the durable abort is started FIRST (against a context that
// is not the cancelled one), then every tracked kill runs, then the abort is
// awaited — so a child that ignores cancellation cannot stall the stop. Every
// kill is attempted even when one throws, and all failures aggregate into one
// LaneDriveError.

import type { Context, Conversation } from '../pi-boundary.js';

export type KillFn = () => void;

export class OperationKillRegistry {
  private readonly kills = new Map<string, KillFn[]>();

  /**
   * Register a kill for `operationId` and return its unregister fn (issue
   * #142). The caller that owns the handle calls it when the handle settles:
   * a lane reuses one registry for the whole session, so a finished call
   * that stayed tracked kept its handle (and its output) alive for the life
   * of the run. Idempotent, and a no-op after a drain.
   */
  track(operationId: string, kill: KillFn): () => void {
    const existing = this.kills.get(operationId) ?? [];
    existing.push(kill);
    this.kills.set(operationId, existing);
    let untracked = false;
    return () => {
      if (untracked) return;
      untracked = true;
      const current = this.kills.get(operationId);
      if (current === undefined) return; // drained already
      const at = current.indexOf(kill);
      if (at === -1) return;
      current.splice(at, 1);
      if (current.length === 0) this.kills.delete(operationId);
    };
  }

  drain(operationId: string): KillFn[] {
    const kills = this.kills.get(operationId) ?? [];
    this.kills.delete(operationId);
    return kills;
  }
}

// The structural lane surface the abort paths need: SoloLane satisfies it,
// and so do unit stubs.
export interface AbortableLane {
  readonly conversation: Conversation;
  readonly kills: OperationKillRegistry;
}

export interface LaneAbortResult {
  /** Kills that ran. Every tracked kill is attempted; a throwing one counts
   *  as a failure, never as a reason to skip the rest. */
  killed: number;
}

export class LaneDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneDriveError';
  }
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Durable abort of the conversation plus the drain of every process group the
// lane tracked for it: the one stop path shared by the guard, the interrupt
// and the TUI quit. Cannot settle `conversation.abort()` on a context that is
// already cancelled, so callers hand it a live one (BACKGROUND_CONTEXT on the
// headless guard path).
export async function abortLane(
  solo: AbortableLane,
  context: Context,
): Promise<LaneAbortResult> {
  const conversationId = String(solo.conversation.id);
  // Started, not awaited: the kills below are what unblocks a child that
  // ignores cancellation.
  const aborting = solo.conversation.abort(context);
  const failures: string[] = [];
  let killed = 0;
  for (const kill of solo.kills.drain(conversationId)) {
    try {
      kill();
      killed += 1;
    } catch (error) {
      failures.push(failureText(error));
    }
  }
  try {
    await aborting;
  } catch (error) {
    failures.push(`lane abort failed: ${failureText(error)}`);
  }
  if (failures.length > 0) {
    throw new LaneDriveError(
      `lane abort failed for ${conversationId}: ${failures.join('; ')}`,
    );
  }
  return { killed };
}

// The settled-turn path: the kills are already dead (the tool tasks
// finished), so drop their handles without running them — a later abort of
// the conversation must not signal a process group that no longer is one.
export function forgetLaneKills(solo: AbortableLane): void {
  solo.kills.drain(String(solo.conversation.id));
}
