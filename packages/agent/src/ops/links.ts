// Where a path really leads. The exec seam's confinement is lexical, so a
// symlink inside the workspace can point out of it; the file tools resolve
// links themselves and refuse a path that a link carries outside — `write`
// and `edit` before they write, `read`, `ls`, `grep` and `find` before they
// open anything.

import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FileSystem } from '@kubic/exec/env';
import type { OpContext } from './types.js';
import { OpError } from './types.js';

export function inside(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}

/**
 * The physical spelling of `path`: every existing prefix resolved, the
 * components that do not exist yet appended verbatim (a write may create
 * them). undefined when the seam cannot resolve links at all, or when a
 * component fails for a reason other than "does not exist" — EACCES, ELOOP —
 * because guessing the verbatim path there could hide a link the OS would
 * follow. The caller then falls back to the named path, whose confinement the
 * seam enforces as before.
 */
export function resolveThroughLinks(
  fs: FileSystem,
  path: string,
): string | undefined {
  const realpath = fs.realpath;
  if (realpath === undefined) return undefined;
  let head = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpath.call(fs, head);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      const parent = dirname(head);
      if (parent === head) return undefined;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Refuse a read-shaped op whose path is inside the workspace — lexically, or
 * spelled through the workspace root's own realpath — but resolves through a
 * link to somewhere outside it. A path outside the workspace entirely is the
 * seam's confinement to refuse, and a seam that cannot resolve links leaves
 * the decision to the seam as well.
 */
export function refuseLinkEscape(
  ctx: OpContext,
  opName: string,
  path: string,
): void {
  const fs = ctx.env.fs;
  const cwd = resolve(ctx.env.cwd);
  const lexical = resolve(cwd, path);
  const root = resolveThroughLinks(fs, cwd);
  const target = resolveThroughLinks(fs, path);
  if (root === undefined || target === undefined || inside(root, target)) {
    return;
  }
  if (inside(cwd, lexical) || inside(root, lexical)) {
    throw new OpError(
      'symlink_escape',
      `${opName} refused: '${path}' resolves to '${target}', outside the workspace`,
    );
  }
}
