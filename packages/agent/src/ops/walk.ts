// Recursive walk over the FileSystem seam.
// Shared by find and grep. Depth-capped so hostile trees terminate, and
// symlink-aware: links are never followed, so a loop cannot
// return the same file under every route. Both caps are reported via
// WalkResult.hitCap / hitDepth so callers surface partial results honestly.
// The ROOT is read as given — the caller named it, and a symlinked root (a
// /tmp path, a linked checkout) must still walk — while every link BELOW it
// is skipped, file or directory, so results never repeat content under a
// second route.
//
// The walk skips `.git` unconditionally and applies the default
// ignore set plus every `.gitignore` on the way down, so a repo-root search
// spends its budget on the repository, not on VCS internals and dependency
// trees. Rules are matched against the path relative to the walk root, which
// also scopes a nested `.gitignore` to its own subtree (the stack frame
// carries the rules; a sibling never sees them).

import type { FileSystem, StatInfo } from '@kubic/exec/env';
import {
  type IgnoreRule,
  isIgnored,
  parseIgnoreFile,
} from '@kubic/exec/ignore';

export const WALK_MAX_DEPTH = 100;
export const WALK_MAX_ENTRIES = 10_000;

// Default ignore set, a gitignore fragment: dependency trees are
// never part of a repo-wide search. Root and nested `.gitignore` files can
// still negate an entry (last match wins), exactly as git lets a closer file
// override a broader one.
const WALK_DEFAULT_IGNORES = 'node_modules/\n';

interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

// The caps and their locations travel together: a `hitCap` result always
// names the directory whose listing was interrupted, and a `hitDepth` result
// the directory whose children the depth bound pruned, so callers never look
// at an unset location.
export type WalkResult =
  | { entries: WalkEntry[]; hitCap: false; hitDepth: false }
  | { entries: WalkEntry[]; hitCap: true; capAt: string; hitDepth: false }
  | { entries: WalkEntry[]; hitCap: false; hitDepth: true; depthAt: string }
  | {
      entries: WalkEntry[];
      hitCap: true;
      capAt: string;
      hitDepth: true;
      depthAt: string;
    };

/** Model-readable cap line for a result that stopped at the walk bound. */
export function walkCapNotice(capAt: string): string {
  return `walk entry cap ${WALK_MAX_ENTRIES} reached while listing ${capAt}; results may be incomplete`;
}

/** Model-readable line for a result pruned by the depth bound. */
export function walkDepthNotice(depthAt: string): string {
  return `walk depth cap ${WALK_MAX_DEPTH} reached at ${depthAt}; results may be incomplete`;
}

function joinPath(root: string, name: string): string {
  return root === '.' || root === ''
    ? name
    : `${root.replace(/\/*$/, '')}/${name}`;
}

// `lstat` when the seam has it, so symlinks are visible; `stat` otherwise
// (test doubles, and seams that predate the method). Undefined = the entry
// vanished between listing and stat — skip it.
function statEntry(
  fs: FileSystem,
  path: string,
): (StatInfo & { isSymbolicLink?: boolean }) | undefined {
  try {
    return fs.lstat ? fs.lstat(path) : fs.stat(path);
  } catch {
    return undefined;
  }
}

interface WalkFrame {
  path: string;
  // Path relative to the walk root; what ignore rules are matched against.
  rel: string;
  depth: number;
  rules: IgnoreRule[];
}

export function walkFiles(fs: FileSystem, root: string): WalkResult {
  const entries: WalkEntry[] = [];
  let depthAt: string | undefined;
  const stack: WalkFrame[] = [
    {
      path: root,
      rel: '',
      depth: 0,
      rules: parseIgnoreFile(WALK_DEFAULT_IGNORES),
    },
  ];
  while (stack.length > 0) {
    const current = stack.pop() as WalkFrame;
    if (current.depth > WALK_MAX_DEPTH) {
      // Prune the subtree and remember where: the result must say the walk
      // was incomplete instead of looking like an empty directory.
      depthAt ??= current.path;
      continue;
    }
    let names: string[];
    try {
      names = fs.listDir(current.path);
    } catch {
      continue;
    }
    // Child rules are appended AFTER the parent's: `isIgnored` is
    // last-match-wins, so a nested negation overrides a broader ignore — the
    // ordering git uses. The array lives on this frame and is dropped when
    // the frame pops, so siblings never see each other's rules.
    let localRules = current.rules;
    if (names.includes('.gitignore')) {
      try {
        localRules = [
          ...current.rules,
          ...parseIgnoreFile(fs.readFile(joinPath(current.path, '.gitignore'))),
        ];
      } catch {
        // Unreadable nested ignore (chmod 000, a permission-denied mount):
        // keep the parent rules and keep walking — the documented widening,
        // never a throw.
      }
    }
    for (const name of names) {
      if (entries.length >= WALK_MAX_ENTRIES) {
        return depthAt === undefined
          ? { entries, hitCap: true, capAt: current.path, hitDepth: false }
          : {
              entries,
              hitCap: true,
              capAt: current.path,
              hitDepth: true,
              depthAt,
            };
      }
      // VCS internals are never repo content, and a `.gitignore` can never
      // un-ignore them: the skip is ahead of the matcher.
      if (name === '.git') continue;
      const full = joinPath(current.path, name);
      const rel = current.rel === '' ? name : `${current.rel}/${name}`;
      const st = statEntry(fs, full);
      if (st === undefined) continue;
      // Never follow a link: a directory link is a second route to a subtree
      // already walked (loops included), and a dangling link has no target
      // to classify. Skipping before the ignore check keeps the rule order
      // irrelevant for links, as it is for `.git`.
      if (st.isSymbolicLink === true) continue;
      if (isIgnored(localRules, rel, st.isDirectory)) continue;
      entries.push({ path: full, isDirectory: st.isDirectory });
      if (st.isDirectory) {
        stack.push({
          path: full,
          rel,
          depth: current.depth + 1,
          rules: localRules,
        });
      }
    }
  }
  return depthAt === undefined
    ? { entries, hitCap: false, hitDepth: false }
    : { entries, hitCap: false, hitDepth: true, depthAt };
}
