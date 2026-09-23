// Worktree confinement (issue #45; §44, §41.1).
// Writes land inside the agent's worktree only: anything outside raises
// the `outside-write` approval instead of proceeding silently.

import { resolve, sep } from 'node:path';
import { WorktreeError } from './errors.js';

export const OUTSIDE_WRITE_CAPABILITY = 'outside-write';

export function isOutsideWorktree(
  worktreePath: string,
  target: string,
): boolean {
  const root = resolve(worktreePath);
  const abs = resolve(root, target);
  return abs !== root && !abs.startsWith(root + sep);
}

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
