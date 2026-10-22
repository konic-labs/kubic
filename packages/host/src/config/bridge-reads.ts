// File reads through the exec bridge that report absence instead of
// throwing, for probes that must never fail a config load.

import type { FileBridge } from '@kubic/exec/file-bridge';

// Repository ignore split: config + roles are committed, the four
// runtime prefixes are ignored. Reads the workspace's ignore wiring through
// the bridge (repo `.gitignore` + local `.git/info/exclude`) and reports the
// missing prefixes by name — the same check the config tests pin, now on a
// production path.
//
// `lstat` on a path under a non-directory throws ENOTDIR (a git WORKTREE has
// a `.git` FILE, not a directory). Absence is the answer we want there, so
// every existence probe in this module goes through this guard — a config
// load must never crash on a repository layout.
export function safeExists(
  bridge: Pick<FileBridge, 'exists'>,
  path: string,
): boolean {
  try {
    return bridge.exists(path);
  } catch {
    return false;
  }
}

export function safeReadTextFile(
  bridge: Pick<FileBridge, 'readTextFile'>,
  path: string,
): string | undefined {
  try {
    return bridge.readTextFile(path);
  } catch {
    return undefined;
  }
}
