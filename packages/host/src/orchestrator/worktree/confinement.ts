// Worktree confinement (issue #45; §44, §41.1).
// Writes land inside the agent's worktree only: anything outside raises
// the `outside-write` approval instead of proceeding silently.

import { resolve, sep } from 'node:path';
import { WorktreeError } from './errors.js';

export const OUTSIDE_WRITE_CAPABILITY = 'outside-write';

// Lexical only: resolve() defeats `..` and absolute escapes but does NOT
// resolve symlinks (a symlink inside the worktree can still point out) and
// is subject to TOCTOU between check and write. realpath is unavailable
// here: host code cannot import node:fs (dep-lint §9) and the ExecutionEnv
// seam exposes no realpath — the write path must re-check at use time.
export function isOutsideWorktree(
  worktreePath: string,
  target: string,
): boolean {
  const root = resolve(worktreePath);
  const abs = resolve(root, target);
  return abs !== root && !abs.startsWith(root + sep);
}

// Caller contract: the write path calls requireInsideWorktree before every
// worktree write and turns the thrown WorktreeError (with its approval
// capability) into an approval gate. No prod caller wires it yet —
// enforcement lands with the write path.
export function requireInsideWorktree(
  worktreePath: string,
  target: string,
): void {
  if (isOutsideWorktree(worktreePath, target)) {
    throw new WorktreeError(
      'outside_worktree',
      `write to ${target} escapes worktree ${worktreePath} — requires '${OUTSIDE_WRITE_CAPABILITY}' approval (§41.1)`,
      1,
      OUTSIDE_WRITE_CAPABILITY,
    );
  }
}

// Spawned-set root for a repo: `<root>/.kubic/wt`, normalized.
export function spawnedRootFor(repoRoot: string): string {
  return resolve(repoRoot, '.kubic/wt');
}

// Normalized shape check (no repoRoot): the resolved path must sit at least
// one segment below a `.kubic/wt` directory pair. Defeats substring bypasses
// such as `/repo/.kubic/wt/../escape` that a raw includes('/.kubic/wt/')
// filter would wrongly keep.
export function isSpawnedWorktreeShape(candidate: string): boolean {
  const segments = resolve(candidate).split(sep);
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] === '.kubic' &&
      segments[i + 1] === 'wt' &&
      (segments[i + 2]?.length ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

// RepoRoot-anchored prefix confinement: the resolved candidate must live
// strictly inside `<repoRoot>/.kubic/wt/`. Direct API calls pass repoRoot so
// a foreign absolute path (another repo's spawned dir, /tmp, /etc) is
// refused even when it has a valid spawned shape.
export function isSpawnedWorktreePath(
  repoRoot: string,
  candidate: string,
): boolean {
  const root = `${spawnedRootFor(repoRoot)}${sep}`;
  return resolve(candidate).startsWith(root);
}
