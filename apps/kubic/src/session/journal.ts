// The boot's journal step: the session's journal store, the baseline the
// end-of-run sweep compares against, and the overlap receipt.

import { join, resolve } from 'node:path';
import {
  type SessionStore,
  sessionLockIsLive,
  sessionsTouchingWorkspace,
  workspacePeers,
} from '@kubic/agent/lane/session-store';
import type { ExecutionEnv } from '@kubic/exec/env';
import {
  beginReconciliation,
  FileJournalStore,
  type ReconciliationPeers,
} from '@kubic/exec/journal';
import type { SessionBoot } from './bootstrap.js';

// The other sessions in this workspace, read when the sweep runs: the paths
// they journaled (their own changes, which this session's sweep leaves out)
// and which of them are live (a change found meanwhile may be theirs, so it
// is recorded as contested). Best-effort: an unreadable peer adds nothing.
function workspaceReconciliationPeers(
  store: SessionStore,
  workspace: string,
  self: string,
): ReconciliationPeers {
  return {
    journaledSince: (since) => {
      const paths = new Set<string>();
      for (const peer of workspacePeers(store, workspace, self)) {
        let entries: ReturnType<FileJournalStore['entries']>;
        try {
          entries = new FileJournalStore(join(peer.dir, 'journal')).entries();
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.op === 'marker' || entry.timestamp < since) continue;
          paths.add(resolve(workspace, entry.path));
        }
      }
      return paths;
    },
    live: () =>
      workspacePeers(store, workspace, self)
        .filter((peer) => sessionLockIsLive(peer.dir) !== undefined)
        .map((peer) => peer.id),
  };
}

// The baseline for the end-of-run sweep: captured ONCE, before the first
// turn, as a metadata walk (hashes only, no blobs). A capture failure is
// not a boot failure — the sweep then simply has no baseline.
export function beginBootJournal(boot: SessionBoot, env: ExecutionEnv): void {
  const id = boot.id;
  boot.journal = new FileJournalStore(
    join(boot.root, id, 'journal'),
    boot.config.journalRetention ?? {},
  );
  try {
    boot.reconciliation = beginReconciliation({
      store: boot.journal,
      root: env.cwd,
      runId: id,
      sessionId: id,
      // Beside the sessions, under a name no session id can take: a later
      // run in this workspace reuses the digests of unchanged files.
      baselineCacheDir: join(boot.root, '.baseline-cache'),
      // A very large file (or a bridge without ranged reads) is named on
      // the debug channel rather than silently costing its size at boot.
      onNotice: (detail: string) => boot.sinks.debug?.(`reconcile: ${detail}`),
      ...(boot.store === undefined
        ? {}
        : {
            peers: workspaceReconciliationPeers(boot.store, env.cwd, id),
          }),
      ...(boot.config.reconcileOutOfScope === undefined
        ? {}
        : { outOfScope: [...boot.config.reconcileOutOfScope] }),
    });
  } catch (error) {
    boot.sinks.debug?.(
      `reconcile: baseline capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Two DIFFERENT sessions in one workspace are legal. Each sweeps against its
// own boot baseline: a sibling's journaled changes are left out, and a change
// found while a sibling is live is recorded as contested (undo skips it
// unless forced). The store can show a session, not its liveness, so the
// line says "may be live". A debug receipt only: never a block, never a boot
// failure.
export async function probeBootOverlap(
  boot: SessionBoot,
  env: ExecutionEnv,
): Promise<void> {
  const { debug } = boot.sinks;
  if (debug === undefined || boot.store === undefined) return;
  try {
    const touching = await sessionsTouchingWorkspace(
      boot.store,
      env.cwd,
      boot.request.context,
    );
    const others = touching.filter((sessionId) => sessionId !== boot.id);
    if (others.length > 0) {
      debug(
        `reconcile: another run may be live in this workspace — a change found while it runs is recorded as contested (sessions: ${others.join(', ')})`,
      );
    }
  } catch (error) {
    debug(
      `reconcile: overlap probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
