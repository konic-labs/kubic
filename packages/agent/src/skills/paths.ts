// Path helpers for skill roots, and the project chain a skill search walks
// (the cwd up to the git top level). Platform paths throughout, so a Windows
// drive path (`D:\repo\pkg`) walks and joins like a POSIX one.
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { FileBridge } from '@kubic/exec/file-bridge';

/** The parts joined and normalized, anchored at the root when relative. */
export function joinPath(...parts: string[]): string {
  return resolve(sep, join(...parts));
}

// Explicit skill paths anchor at the invoking
// cwd, never at the root and never at whatever root the caller's bridge
// carries. Absolute values pass through (normalized); relative values —
// './rel-skill', 'rel-skill', '../up/skill', 'rel/SKILL.md' — resolve
// against the cwd, so `kubic run` (sessions-rooted bridge) and `kubic tui`
// (cwd bridge) agree. joinPath cannot do this: it anchors at the root.
// A relative path stays relative and never climbs above its start.
export function normalizeSkillPath(path: string): string {
  if (isAbsolute(path)) return resolve(path);
  return normalize(path)
    .split(sep)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join(sep);
}

export function resolveSkillPath(cwd: string, value: string): string {
  if (isAbsolute(value)) return normalizeSkillPath(value);
  return normalizeSkillPath(join(cwd, value));
}

export function basenameOf(path: string): string {
  return basename(path);
}

export function dirnameOf(path: string): string {
  return dirname(path);
}

// Ancestors nearest-first, up to the root: /a/b -> ['/a/b', '/a', '/'],
// D:\a -> ['D:\a', 'D:\']. A root is its own parent, which ends the walk.
function ancestorsOf(cwd: string): string[] {
  const out: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

// The repository top level, Pi-style — the nearest
// ancestor (itself included) holding a `.git` entry. Probed through the
// injected bridge (I/O confinement: no node:fs here); an unreadable path
// reads as "no marker", never fatal.
function findRepoRoot(
  bridge: Pick<FileBridge, 'exists'>,
  cwd: string,
): string | undefined {
  for (const ancestor of ancestorsOf(cwd)) {
    let hasMarker = false;
    try {
      hasMarker = bridge.exists(join(ancestor, '.git'));
    } catch {
      hasMarker = false;
    }
    if (hasMarker) return ancestor;
  }
  return undefined;
}

// The trusted-ancestor chain for project + package skills is
// the repo root down to the cwd, far-to-near — the cwd alone outside a
// repository. Trusting one repo must not trust instructions from a parent
// directory, a shared /tmp, or $HOME, and a package.json above the root
// contributes nothing (it is never walked to).
export function projectChain(
  bridge: Pick<FileBridge, 'exists'>,
  cwd: string,
): string[] {
  const root = findRepoRoot(bridge, cwd);
  if (root === undefined) return [resolve(cwd)];
  return ancestorsOf(cwd)
    .filter((dir) => isWithinDir(dir, root))
    .reverse();
}

// A package-declared skill dir is confined to the ancestor
// whose package.json declared it (the trusted root it was discovered
// under). An absolute path or a `..` escape landing outside never loads,
// and neither does a symlink resolving outside (realpath, so links
// count) — each refusal carries its reason on the log sink. Without the
// bridge's realPath seam the check is lexical only.
//
// The boundary is deliberately the DECLARING package's directory, not
// the repo root: per the per-ancestor trust model a grant
// for `/repo/pkg` covers `/repo/pkg` only, so a `/repo/pkg` entry for
// `../sibling` is refused even though the sibling is inside the same
// repo. A transient realPath failure fails closed (error skip, never a
// lexical fallback load).
export function isWithinDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
