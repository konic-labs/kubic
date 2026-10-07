// Project-root resolution. The config project layer,
// the repo role documents and the runtime-exclude check all resolve their
// files from ONE root — the nearest ancestor holding `.kubic/` (or the git
// top level), the cwd itself outside a repository — so a run from a
// subdirectory sees the same project files as a run from the root.
//
// Probed through the injected bridge (this module never touches node:fs,
// mirroring `findModelsProjectRoot`'s walk but injectable so tests drive
// fakes). Like its models sibling, a `.kubic` AT the home directory never
// counts (that tree is the GLOBAL layer) while a `.git` there still does
// (home really is a repository). An unreadable path reads as "no marker",
// never fatal — the layer read itself fails closed with its named error.
import { dirname, join, resolve } from 'node:path';
import type { FileBridge } from '../../exec/src/file-bridge.js';

function hasMarker(
  bridge: Pick<FileBridge, 'exists'>,
  dir: string,
  name: string,
): boolean {
  try {
    return bridge.exists(join(dir, name));
  } catch {
    return false;
  }
}

export function findProjectRoot(
  bridge: Pick<FileBridge, 'exists'>,
  cwd: string,
  home?: string,
): string {
  const fallback = resolve(cwd);
  const homeDir = home === undefined || home === '' ? undefined : resolve(home);
  let dir = fallback;
  for (;;) {
    if (hasMarker(bridge, dir, '.git')) return dir;
    if (dir !== homeDir && hasMarker(bridge, dir, '.kubic')) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}
