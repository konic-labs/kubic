// Worktree confinement (issue #45; §44, §41.1).
// Writes land inside the agent's worktree only: anything outside raises
// the `outside-write` approval instead of proceeding silently.

import { resolve, sep } from 'node:path';
import { WorktreeError } from './errors.js';
import { DEFAULT_WORKTREE_ROOT } from './naming.js';

export const OUTSIDE_WRITE_CAPABILITY = 'outside-write';

// The configured root's literal segments (never resolved against cwd: the
// root is workspace-relative by contract). An absolute or `..`-bearing root
// yields no shape at all — nothing matches, fail-closed.
function rootSegmentsOf(worktreeRoot: string): string[] | undefined {
  if (worktreeRoot.startsWith('/') || worktreeRoot.split('/').includes('..')) {
    return undefined;
  }
  const segments = worktreeRoot
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  return segments.length === 0 ? undefined : segments;
}

// Lexical only: resolve() defeats `..` and absolute escapes but does NOT
// resolve symlinks (live probe: a symlink inside the worktree pointing out
// passes this check) and is subject to TOCTOU between check and write.
// realpath is unavailable here: host code cannot import node:fs (dep-lint
// §9) and the ExecutionEnv seam exposes no realpath. REQUIRED: the write
// path MUST re-check with a realpath resolution at use time (immediately
// before the write) when it lands — this function alone never gates writes.
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

// Spawned-set root for a repo: `<root>/<worktreeRoot>`, normalized. The
// parent is `.kubic/wt` unless `[orchestrator].root` names another
// workspace-relative one (issue #133).
export function spawnedRootFor(
  repoRoot: string,
  worktreeRoot: string = DEFAULT_WORKTREE_ROOT,
): string {
  return resolve(repoRoot, worktreeRoot);
}

// Normalized shape check (no repoRoot): the resolved path must sit at least
// one segment below the configured root's segment pair. Defeats substring
// bypasses such as `/repo/.kubic/wt/../escape` that a raw
// includes('/.kubic/wt/') filter would wrongly keep.
export function isSpawnedWorktreeShape(
  candidate: string,
  worktreeRoot: string = DEFAULT_WORKTREE_ROOT,
): boolean {
  const rootSegments = rootSegmentsOf(worktreeRoot);
  if (rootSegments === undefined) return false;
  const segments = resolve(candidate).split(sep);
  for (let i = 0; i + rootSegments.length < segments.length; i += 1) {
    if (
      rootSegments.every((segment, j) => segments[i + j] === segment) &&
      (segments[i + rootSegments.length]?.length ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

// RepoRoot-anchored prefix confinement: the resolved candidate must live
// strictly inside `<repoRoot>/<worktreeRoot>/`. Direct API calls pass repoRoot
// so a foreign absolute path (another repo's spawned dir, /tmp, /etc) is
// refused even when it has a valid spawned shape.
export function isSpawnedWorktreePath(
  repoRoot: string,
  candidate: string,
  worktreeRoot: string = DEFAULT_WORKTREE_ROOT,
): boolean {
  const root = `${spawnedRootFor(repoRoot, worktreeRoot)}${sep}`;
  return resolve(candidate).startsWith(root);
}
