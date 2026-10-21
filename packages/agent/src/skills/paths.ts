// POSIX path helpers for skill roots, and the project chain a skill search
// walks (the cwd up to the git top level).
import type { FileBridge } from '@kubic/exec/file-bridge';

export function joinPosix(...parts: string[]): string {
  const segments: string[] = [];
  for (const chunk of parts.join('/').split('/')) {
    if (chunk === '' || chunk === '.') continue;
    if (chunk === '..') {
      segments.pop();
      continue;
    }
    segments.push(chunk);
  }
  return `/${segments.join('/')}`;
}

// Explicit skill paths anchor at the invoking
// cwd, never at '/' and never at whatever root the caller's bridge
// carries. Absolute values pass through (normalized); relative values —
// './rel-skill', 'rel-skill', '../up/skill', 'rel/SKILL.md' — resolve
// against the cwd, so `kubic run` (sessions-rooted bridge) and `kubic tui`
// (cwd bridge) agree. joinPosix cannot do this: it roots everything at '/'.
export function normalizeSkillPath(path: string): string {
  const absolute = path.startsWith('/');
  const segments: string[] = [];
  for (const chunk of path.split('/')) {
    if (chunk === '' || chunk === '.') continue;
    if (chunk === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(chunk);
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

export function resolveSkillPath(cwd: string, value: string): string {
  if (value.startsWith('/')) return normalizeSkillPath(value);
  return normalizeSkillPath(`${cwd}/${value}`);
}

export function basenameOf(path: string): string {
  const clean = path.replace(/\/*$/, '');
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

export function dirnameOf(path: string): string {
  const clean = path.replace(/\/*$/, '');
  const slash = clean.lastIndexOf('/');
  if (slash === -1) return '.';
  if (slash === 0) return '/';
  return clean.slice(0, slash);
}

// Ancestors nearest-first: /a/b -> ['/a/b', '/a', '/'].
function ancestorsOf(cwd: string): string[] {
  const clean = cwd.replace(/\/*$/, '') || '/';
  const out: string[] = [];
  let current = clean;
  for (;;) {
    out.push(current);
    if (current === '/') break;
    current = dirnameOf(current);
  }
  return out;
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
      hasMarker = bridge.exists(joinPosix(ancestor, '.git'));
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
  if (root === undefined) return [cwd.replace(/\/*$/, '') || '/'];
  if (root === '/') return ancestorsOf(cwd).reverse();
  return ancestorsOf(cwd)
    .filter((dir) => dir === root || dir.startsWith(`${root}/`))
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
  const cleanDir = dir.replace(/\/*$/, '') || '/';
  if (cleanDir === '/') return true;
  return path === cleanDir || path.startsWith(`${cleanDir}/`);
}
