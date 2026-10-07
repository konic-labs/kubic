// Read-only roots outside the cwd.
// Skills discovered under $HOME and trusted ancestor project roots are
// advertised to the model with absolute `<filePath>`s. The cwd confinement
// would refuse every one of them, so the advertised skills could never be
// loaded. This seam opens EXACTLY those roots (a skill's directory, or the
// skill file itself) for the read-shaped calls — readFile, readFileRange,
// stat, lstat — and nothing else: writes, renames, chmod and listings keep
// the cwd confinement, and any path outside a root falls through to it.
// Every optional method the base seam offers is forwarded: the
// wrapper once dropped `lstat`, so a walk fell back to `stat` and followed
// symlink loops for any user with a skill outside the workspace.
// Lexical like the cwd guard (no symlink resolution).

import { dirname, isAbsolute, resolve, sep } from 'node:path';
import {
  type ExecutionEnv,
  type FileSystem,
  NodeExecutionEnv,
  type Provenance,
} from './env.js';

// The root an absolute path lies in (the root itself or below it), if any.
// A relative path never matches: it is a workspace path by definition.
export function readRootFor(
  roots: readonly string[],
  path: string,
): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const abs = resolve(path);
  return roots.find((root) => abs === root || abs.startsWith(`${root}${sep}`));
}

export function withReadRoots(
  env: ExecutionEnv,
  roots: readonly string[],
  open: (dir: string) => FileSystem = (dir) => new NodeExecutionEnv(dir).fs,
): ExecutionEnv {
  if (roots.length === 0) return env;
  const normalized = roots.map((root) => resolve(root));
  const base = env.fs;
  // The reading seam for a root: confined to the root's parent directory,
  // and only reached for paths readRootFor already placed inside the root.
  const via = (path: string): FileSystem | undefined => {
    const root = readRootFor(normalized, path);
    return root === undefined ? undefined : open(dirname(root));
  };
  const fs: FileSystem = {
    readFile: (path) => (via(path) ?? base).readFile(path),
    stat: (path) => (via(path) ?? base).stat(path),
    writeFile: (path, content) => base.writeFile(path, content),
    rename: (from, to) => base.rename(from, to),
    listDir: (path) => base.listDir(path),
    ...(base.lstat === undefined
      ? {}
      : {
          lstat: (path: string) => {
            const rooted = via(path);
            if (rooted?.lstat !== undefined) return rooted.lstat(path);
            return (base.lstat as NonNullable<FileSystem['lstat']>).call(
              base,
              path,
            );
          },
        }),
    ...(base.readFileRange === undefined
      ? {}
      : {
          readFileRange: (path: string, start: number, end: number) => {
            const rooted = via(path);
            if (rooted?.readFileRange !== undefined) {
              return rooted.readFileRange(path, start, end);
            }
            return (
              base.readFileRange as NonNullable<FileSystem['readFileRange']>
            ).call(base, path, start, end);
          },
        }),
    ...(base.chmod === undefined
      ? {}
      : {
          chmod: (path: string, mode: number) =>
            (base.chmod as NonNullable<FileSystem['chmod']>).call(
              base,
              path,
              mode,
            ),
        }),
    ...(base.realpath === undefined
      ? {}
      : {
          realpath: (path: string) => {
            const rooted = via(path);
            if (rooted?.realpath !== undefined) return rooted.realpath(path);
            return (base.realpath as NonNullable<FileSystem['realpath']>).call(
              base,
              path,
            );
          },
        }),
    // Writes go to base (confinement is cwd-only), so the tmp
    // cleanup does too. Without this forward the wrapper would drop the
    // method and every failed write in a run with read roots would leak its
    // tmp.
    ...(base.unlink === undefined
      ? {}
      : {
          unlink: (path: string) => {
            (base.unlink as NonNullable<FileSystem['unlink']>).call(base, path);
          },
        }),
  };
  return {
    cwd: env.cwd,
    fs,
    shell: env.shell,
    provenance: env.provenance,
    withProvenance: (next: Provenance) =>
      withReadRoots(env.withProvenance(next), normalized, open),
  };
}
