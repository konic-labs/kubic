import {
  appendToLedger,
  auditLedgerDirFor,
  fullAccessDisabledAudit,
  fullAccessEnabledAudit,
} from '../audit/index.js';
import type { AccessPosture } from './stores.js';
import { FileApprovalStore } from './stores.js';

export function enableFullAccess(
  store: FileApprovalStore,
  by: string,
  clock: () => number = Date.now,
): AccessPosture {
  const posture: AccessPosture = {
    fullAccess: true,
    enabledAt: clock(),
    enabledBy: by,
  };
  store.savePosture(posture);
  return posture;
}

// The symmetric half — a session switched back to
// enforced approvals. Writes the same posture.json the enable path writes
// (so a resume boots enforced) and returns the posture it recorded.
function disableFullAccess(
  store: FileApprovalStore,
  by: string,
  clock: () => number = Date.now,
): AccessPosture {
  const posture: AccessPosture = {
    fullAccess: false,
    enabledAt: clock(),
    enabledBy: by,
  };
  store.savePosture(posture);
  return posture;
}

// The one flag name for session-scoped full access.
export const FULL_ACCESS_FLAG = '--dangerously-skip-approvals';

export interface SessionFullAccessOptions {
  /**
   * The session dir whose posture.json records the grant. Absent: only the
   * audit row and the warning are produced.
   */
  sessionDir?: string;
  sessionId: string;
  /** The command after `kubic`: 'run', 'tui', 'sessions create'. */
  command: string;
  /** Resolves the repo ledger (resolveRepoRuntimeRoot). */
  workspace: string;
  clock?: () => number;
  onAuditError?: (message: string) => void;
}

export interface SessionFullAccessGrant {
  posture: AccessPosture;
  /** The stderr warning every enabling command prints, word for word. */
  warning: string;
}

interface FullAccessChange {
  enabled: boolean;
  /** The command recorded in the posture file and the audit row. */
  by: string;
  sessionId: string;
  workspace: string;
  /** The posture store to write; absent falls back to `sessionDir`. */
  store?: FileApprovalStore;
  sessionDir?: string;
  clock?: () => number;
  onAuditError?: (message: string) => void;
}

// The ONE writer for a session-scoped full-access change: the posture file and
// its audit row are produced here, so the CLI-shaped session helpers and the
// installed policy's in-session toggle cannot drift into two writers for one
// row shape. Exactly one clock read produces the record the file holds, and it
// is RETURNED, so a caller that keeps an in-memory posture (the guard's
// baseline) re-bases on the file's own values instead of a second `Date.now()`
// that could tick in between — a difference the guard would read as a foreign
// change and answer with a false `posture:changed-mid-session` row.
export function recordFullAccessChange(
  change: FullAccessChange,
): AccessPosture {
  const clock = change.clock ?? Date.now;
  const store =
    change.store ??
    (change.sessionDir === undefined
      ? undefined
      : new FileApprovalStore(change.sessionDir));
  const posture: AccessPosture =
    store === undefined
      ? {
          fullAccess: change.enabled,
          enabledAt: clock(),
          enabledBy: change.by,
        }
      : change.enabled
        ? enableFullAccess(store, change.by, clock)
        : disableFullAccess(store, change.by, clock);
  appendToLedger(
    auditLedgerDirFor(change.workspace),
    change.enabled
      ? fullAccessEnabledAudit({
          sessionId: change.sessionId,
          command: change.by,
          workspace: change.workspace,
        })
      : fullAccessDisabledAudit({
          sessionId: change.sessionId,
          command: change.by,
          workspace: change.workspace,
        }),
    change.onAuditError,
  );
  return posture;
}

// The ONE enable path for session-scoped full access: `kubic`,
// `kubic tui`, `kubic run` and `kubic sessions create` all come through
// here. It records the posture in the session dir (never in
// config), appends one audit row naming the session and the originating
// command, and returns the warning the caller prints on stderr.
export function enableSessionFullAccess(
  options: SessionFullAccessOptions,
): SessionFullAccessGrant {
  const commandLine = `kubic ${options.command} ${FULL_ACCESS_FLAG}`;
  const posture = recordFullAccessChange({
    enabled: true,
    by: commandLine,
    sessionId: options.sessionId,
    workspace: options.workspace,
    ...(options.sessionDir === undefined
      ? {}
      : { sessionDir: options.sessionDir }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onAuditError === undefined
      ? {}
      : { onAuditError: options.onAuditError }),
  });
  return {
    posture,
    warning: `full-access approvals skipped for session ${options.sessionId} (recorded ${posture.enabledAt}) — every challenged call runs without asking`,
  };
}

// The warning a headless run prints when the session it runs in already has
// full access: a scripted caller must never be surprised.
export function fullAccessInForceWarning(sessionId: string): string {
  return `session ${sessionId} runs with full access: approvals are skipped for every challenged call`;
}
