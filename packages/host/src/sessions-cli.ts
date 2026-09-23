// `kubic sessions` commands (issue #14, slice F): create, list, attach.
// Thin over the worker session store; presentation only (one line per
// fact). attach prints metadata plus the transcript tail so a user can
// confirm what they are resuming before driving it.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  listSessions,
  openSessionStore,
  SessionAttachError,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { enableFullAccess, FileApprovalStore } from './approvals.js';

export interface SessionsCommandDeps {
  sessionsRoot?: string;
  out: (line: string) => void;
}

export function defaultSessionsRoot(): string {
  return join(homedir(), '.kubic', 'sessions');
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic sessions <create [--cwd <path>] [--dangerously-skip-approvals] | list | attach <id> [--tail <n>]>',
  );
  return 1;
}

export async function runSessionsCommand(
  args: string[],
  deps: SessionsCommandDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) return usage(deps.out);
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  const store = openSessionStore(root, createNodeFileBridge(root));
  if (sub === 'create') {
    let cwd = process.cwd();
    const flag = rest.indexOf('--cwd');
    if (flag !== -1) {
      const value = rest[flag + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --cwd needs a value');
        return 1;
      }
      cwd = value;
    }
    const session = await createSession(store, cwd, BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    deps.out(id);
    // Session-scoped full-access: recorded in the session dir (posture.json)
    // and indicated on stdout. Fresh sessions start safe — the flag must be
    // passed explicitly every time.
    if (rest.includes('--dangerously-skip-approvals')) {
      const approvalStore = new FileApprovalStore(join(root, id));
      const posture = enableFullAccess(
        approvalStore,
        'cli --dangerously-skip-approvals',
      );
      deps.out(
        `warning: full-access approvals skipped (recorded ${posture.enabledAt})`,
      );
    }
    return 0;
  }
  if (sub === 'list') {
    const sessions = await listSessions(store, BACKGROUND_CONTEXT);
    for (const entry of sessions) {
      deps.out(`${entry.id}  ${entry.cwd ?? '(no cwd)'}`);
    }
    return 0;
  }
  if (sub === 'attach') {
    const id = rest[0];
    if (id === undefined) {
      deps.out('error: attach needs a session id');
      return 1;
    }
    let tail = 10;
    const flag = rest.indexOf('--tail');
    if (flag !== -1) {
      const parsed = Number(rest[flag + 1]);
      if (!Number.isInteger(parsed) || parsed < 0) {
        deps.out('error: --tail needs a non-negative integer');
        return 1;
      }
      tail = parsed;
    }
    try {
      const session = await attachSession(store, id, BACKGROUND_CONTEXT);
      try {
        deps.out(
          `session ${session.metadata.id}  cwd=${session.metadata.cwd ?? '(none)'}`,
        );
        const posture = new FileApprovalStore(join(root, id)).loadPosture();
        deps.out(
          posture.fullAccess
            ? `posture: full-access (enabled ${posture.enabledAt ?? 'unknown'} by ${posture.enabledBy ?? 'unknown'})`
            : 'posture: approvals enforced',
        );
        const entries = await session.findEntries(
          undefined,
          BACKGROUND_CONTEXT,
        );
        const last = entries.slice(Math.max(0, entries.length - tail));
        for (const entry of last) {
          deps.out(JSON.stringify(entry).slice(0, 300));
        }
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
    } catch (error) {
      if (error instanceof SessionAttachError) {
        deps.out(`error: ${error.message}`);
        return 1;
      }
      throw error;
    }
    return 0;
  }
  return usage(deps.out);
}
