// Reading sessions without running them (issues #250, #251): the lock-free
// read-only open and the project test `kubic cost` and the TUI's `/resume`
// summaries (session-summaries.ts, #461) share. Nothing here creates or
// removes `lock.json` or writes a byte, so the session dir mtime (the prune
// age signal) stays untouched.

import { join, sep } from 'node:path';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { bridgeToPiFileSystem } from '../../worker/src/lane/session-fs.js';
import { SessionAttachError } from '../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  JsonlStorage,
  type Storage,
} from '../../worker/src/pi-boundary.js';

// Issue #251: lock-free read-only open of one session's storage. The
// caller classified the session via `listSessions` and probed no live
// holder via `sessionLockIsLive`, so this never creates or removes
// `lock.json` and a concurrent attach is never blocked. A missing storage
// is an unknown session, exactly as `attachSession` reports it.
export async function openReadOnlySessionStorage(
  sessionsRoot: string,
  sessionId: string,
): Promise<Storage> {
  const bridge = createNodeFileBridge(sessionsRoot);
  if (!bridge.exists(join(sessionsRoot, sessionId, 'main.jsonl'))) {
    throw new SessionAttachError(sessionId);
  }
  // The portable core over the exec bridge, never the `/node` entry point:
  // session bytes keep crossing the I/O seam, where the #359 secret
  // scrubbing and the #361 file modes live (see session-fs.ts). fsync stays
  // off — a reader never commits, so there is nothing to flush.
  return JsonlStorage.open(
    join(sessionsRoot, sessionId),
    bridgeToPiFileSystem(bridge),
    BACKGROUND_CONTEXT,
    { fsync: false },
  );
}

// Issue #250 (§39): the invoking workspace, canonically. Symlinks are
// resolved (macOS /var → /private/var); a path that no longer exists keeps
// its lexical form, matching journal-cli's rule, so it can then only match
// itself.
function canonicalWorkspace(path: string): string {
  try {
    return createNodeFileBridge('/').realPath?.(path) ?? path;
  } catch {
    return path;
  }
}

// Issue #250: whether a session belongs to the invoking project. The
// recorded workspace (`meta.workspace ?? meta.cwd`) matches when it nests
// with the invocation either way — a run started at the repo root covers a
// reader in a subdirectory, and a subdir run still belongs to a reader at
// the root — so both directions count as touching the workspace.
export function touchesWorkspace(
  recorded: string | undefined,
  workspace: string,
): boolean {
  if (recorded === undefined || recorded === '') return false;
  const left = canonicalWorkspace(recorded);
  const right = canonicalWorkspace(workspace);
  if (left === right) return true;
  const below = (parent: string, child: string): boolean =>
    child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  return below(left, right) || below(right, left);
}
