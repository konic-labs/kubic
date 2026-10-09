// Reading sessions without running them: the lock-free
// read-only open and the project test `kubic cost` and the TUI's `/resume`
// summaries (session-summaries.ts) share. Nothing here creates or
// removes `lock.json` or writes a byte, so the session dir mtime (the prune
// age signal) stays untouched.

import { isAbsolute, join, sep } from 'node:path';
import { bridgeToPiFileSystem } from '@kubic/agent/lane/session-fs';
import { SessionAttachError } from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  JsonlStorage,
  type Storage,
} from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';

// Lock-free read-only open of one session's storage. The
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
  // session bytes keep crossing the I/O seam, where the secret
  // scrubbing and the file modes live (see session-fs.ts). fsync stays
  // off — a reader never commits, so there is nothing to flush.
  return JsonlStorage.open(
    join(sessionsRoot, sessionId),
    bridgeToPiFileSystem(bridge),
    BACKGROUND_CONTEXT,
    { fsync: false },
  );
}

// The invoking workspace, canonically. Symlinks are
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

// Whether a session belongs to the invoking project. The
// recorded workspace (`meta.workspace ?? meta.cwd`) matches when it nests
// with the invocation either way — a run started at the repo root covers a
// reader in a subdirectory, and a subdir run still belongs to a reader at
// the root — so both directions count as touching the workspace. A relative
// record has no anchor and never matches: resolved against the filesystem
// root, it could land on a real directory that only shares its name.
export function touchesWorkspace(
  recorded: string | undefined,
  workspace: string,
): boolean {
  if (recorded === undefined || !isAbsolute(recorded)) return false;
  const left = canonicalWorkspace(recorded);
  const right = canonicalWorkspace(workspace);
  if (left === right) return true;
  const below = (parent: string, child: string): boolean =>
    child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  return below(left, right) || below(right, left);
}
