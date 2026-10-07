// Write targets inside a `.git` directory. An agent that plants
// `.git/hooks/*` or sets `core.hooksPath` in `.git/config` runs code on the
// user's next git command, and the journal never sees it (its sweep skips
// `.git/`), so such writes always ask (see `approvals.ts`).

import { dirname, join, relative, resolve, sep } from 'node:path';

function stripSurroundingQuotes(target: string): string {
  if (
    target.length >= 2 &&
    ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'")))
  ) {
    return target.slice(1, -1);
  }
  return target;
}

/**
 * True when a write target lands at or under a gitdir — lexically (no fs
 * access), case-folded (macOS/Windows filesystems are case-insensitive).
 * `..` escapes resolve outside and do not match; globs stay literal and
 * still match by prefix.
 *
 * The workspace's own `.git/` and every ancestor's count: a run started in
 * `<repo>/sub` still shares `<repo>/.git`. A target under an unrelated
 * `.git` (a sibling subtree, another checkout) does not match.
 */
export function isGitDirTarget(workspace: string, target: string): boolean {
  const trimmed = stripSurroundingQuotes(target.trim());
  if (trimmed === '') return false;
  const ws = resolve(workspace);
  const folded = resolve(ws, trimmed).toLowerCase();
  for (let dir = ws; ; dir = dirname(dir)) {
    if (underGitDir(dir, folded)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
  }
}

function underGitDir(dir: string, foldedTarget: string): boolean {
  const foldedGitDir = `${join(dir, '.git')}${sep}`.toLowerCase();
  if (foldedTarget === foldedGitDir.slice(0, -1)) return true;
  if (!foldedTarget.startsWith(foldedGitDir)) return false;
  const rel = relative(dir.toLowerCase(), foldedTarget);
  return rel === '.git' || rel.startsWith(`.git${sep}`);
}
