// The boot's journal step: the session's journal store, the baseline the
// end-of-run sweep compares against, and the overlap receipt.

import { join } from 'node:path';
import { sessionsTouchingWorkspace } from '@kubic/agent/lane/session-store';
import type { ExecutionEnv } from '@kubic/exec/env';
import { beginReconciliation, FileJournalStore } from '@kubic/exec/journal';
import type { SessionBoot } from './bootstrap.js';

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
      // A very large file (or a bridge without ranged reads) is named on
      // the debug channel rather than silently costing its size at boot.
      onNotice: (detail: string) => boot.sinks.debug?.(`reconcile: ${detail}`),
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

// Two DIFFERENT sessions in one workspace are legal, but each sweeps
// against its own boot baseline, so a live sibling's in-progress changes
// land in this session's journal as unattributed, non-reversible entries.
// The store can show a session, not its liveness, so the line says "may
// be live". A debug receipt only: never a block, never a boot failure.
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
        `reconcile: another run may be live in this workspace — its in-progress changes will be recorded as unattributed (sessions: ${others.join(', ')})`,
      );
    }
  } catch (error) {
    debug(
      `reconcile: overlap probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
