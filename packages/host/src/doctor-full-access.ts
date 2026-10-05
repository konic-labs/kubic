// Doctor's full-access session enumeration (issue #310; §41.4): the
// current workspace's LIVE sessions whose posture.json records fullAccess.
// posture.json is the live record — #308's flag and #309's toggle both
// write it, #325 guards it — so a live session with fullAccess=true has
// approvals off right now. A released (dead) session is skipped even when
// its posture file outlives it: the grant expired with the session end.
// Lock-free: the listing header plus the read-only lock probe, never an
// attach (the #251 rule — doctor must not block a concurrent run).
import { join } from 'node:path';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  openSessionStore,
  sessionLockIsLive,
  sessionsTouchingWorkspace,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { FileApprovalStore } from './approvals.js';

export interface FullAccessSession {
  sessionId: string;
  enabledAt?: number;
  enabledBy?: string;
}

// The one-session read behind `doctor --session <id>` (issue #310): the
// same live + fullAccess rule as the workspace enumeration, without the
// workspace filter — the operator named the session explicitly. Undefined
// covers missing, released, enforced and legacy sessions alike.
export async function describeFullAccessSession(
  sessionsRoot: string,
  sessionId: string,
): Promise<FullAccessSession | undefined> {
  const dir = join(sessionsRoot, sessionId);
  if (sessionLockIsLive(dir) === undefined) return undefined;
  const posture = new FileApprovalStore(dir).loadPosture();
  if (posture.fullAccess !== true) return undefined;
  return {
    sessionId,
    ...(posture.enabledAt === undefined
      ? {}
      : { enabledAt: posture.enabledAt }),
    ...(posture.enabledBy === undefined
      ? {}
      : { enabledBy: posture.enabledBy }),
  };
}

export async function listFullAccessSessions(input: {
  sessionsRoot: string;
  workspace: string;
}): Promise<FullAccessSession[]> {
  const store = openSessionStore(
    input.sessionsRoot,
    createNodeFileBridge(input.sessionsRoot),
  );
  // Workspace association first (the #118 overlap probe's rule: the
  // session's declared workspace, else its cwd — exact match, durable
  // sessions only), then liveness, then posture. Each step is
  // corrupt-tolerant: an unreadable session is skipped, never fatal.
  const ids = await sessionsTouchingWorkspace(
    store,
    input.workspace,
    BACKGROUND_CONTEXT,
  );
  const sessions: FullAccessSession[] = [];
  for (const id of ids) {
    const dir = join(input.sessionsRoot, id);
    if (sessionLockIsLive(dir) === undefined) continue;
    const posture = new FileApprovalStore(dir).loadPosture();
    if (posture.fullAccess !== true) continue;
    sessions.push({
      sessionId: id,
      ...(posture.enabledAt === undefined
        ? {}
        : { enabledAt: posture.enabledAt }),
      ...(posture.enabledBy === undefined
        ? {}
        : { enabledBy: posture.enabledBy }),
    });
  }
  return sessions;
}
