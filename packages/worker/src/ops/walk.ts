// Recursive walk over the FileSystem seam (issue #13, slice B).
// Shared by find and grep. Depth-capped so hostile trees (and symlink
// loops on the Node binding) terminate; the entry cap is reported via
// WalkResult.hitCap so callers surface partial results honestly.

import type { FileSystem } from '../../../exec/src/env.js';

export const WALK_MAX_DEPTH = 100;
export const WALK_MAX_ENTRIES = 10_000;

export interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

export interface WalkResult {
  entries: WalkEntry[];
  hitCap: boolean;
}

function joinPath(root: string, name: string): string {
  return root === '.' || root === ''
    ? name
    : `${root.replace(/\/*$/, '')}/${name}`;
}

export function walkFiles(fs: FileSystem, root: string): WalkResult {
  const entries: WalkEntry[] = [];
  let hitCap = false;
  const stack: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop() as { path: string; depth: number };
    if (current.depth > WALK_MAX_DEPTH) continue;
    let names: string[];
    try {
      names = fs.listDir(current.path);
    } catch {
      continue;
    }
    for (const name of names) {
      if (entries.length >= WALK_MAX_ENTRIES) {
        hitCap = true;
        return { entries, hitCap };
      }
      const full = joinPath(current.path, name);
      let st: { isDirectory: boolean };
      try {
        st = fs.stat(full);
      } catch {
        continue;
      }
      entries.push({ path: full, isDirectory: st.isDirectory });
      if (st.isDirectory) stack.push({ path: full, depth: current.depth + 1 });
    }
  }
  return { entries, hitCap };
}
