// The Node file system behind the seam, confined to the workspace root.

import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { FileSystem, StatInfo } from './contracts.js';

function confine(cwd: string, path: string): string {
  // Lexical guardrail only: resolve() defeats `..` and absolute escapes but
  // does NOT resolve symlinks — a symlink inside the cwd can still point
  // out, which the agent's file tools check for themselves through realpath
  // (symlink_escape). Kubic has no isolation: this is an accidental-escape
  // guard, not a sandbox boundary.
  const abs = resolve(cwd, path);
  if (abs === cwd || abs.startsWith(cwd + sep)) return abs;
  // The cwd itself may be reached through a symlink (macOS
  // resolves /tmp and /var to /private/…), so a caller holding a path the
  // OS resolved spells the same tree with the physical prefix. Accepting
  // both keeps the guardrail — the path is still this workspace — without
  // refusing a legitimate write to a realpath'd target.
  const real = physicalRoot(cwd);
  if (
    real !== undefined &&
    real !== cwd &&
    (abs === real || abs.startsWith(real + sep))
  )
    return abs;
  throw new Error(`path escapes cwd confinement: ${path}`);
}

// realpath(cwd), cached: confine runs on every op's I/O and the workspace
// root does not move. undefined = the cwd itself cannot be resolved.
const physicalRoots = new Map<string, string | undefined>();

function physicalRoot(cwd: string): string | undefined {
  if (physicalRoots.has(cwd)) return physicalRoots.get(cwd);
  let real: string | undefined;
  try {
    real = realpathSync(cwd);
  } catch {
    real = undefined;
  }
  physicalRoots.set(cwd, real);
  return real;
}

export class NodeFileSystem implements FileSystem {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  readFile(path: string): string {
    return readFileSync(confine(this.cwd, path), 'utf8');
  }

  writeFile(path: string, content: string): void {
    const abs = confine(this.cwd, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  rename(from: string, to: string): void {
    renameSync(confine(this.cwd, from), confine(this.cwd, to));
  }

  listDir(path: string): string[] {
    return readdirSync(confine(this.cwd, path));
  }

  stat(path: string): StatInfo {
    const st = statSync(confine(this.cwd, path));
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mode: st.mode & 0o7777,
    };
  }

  lstat(path: string): StatInfo & { isSymbolicLink: boolean } {
    const st = lstatSync(confine(this.cwd, path));
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mode: st.mode & 0o7777,
      isSymbolicLink: st.isSymbolicLink(),
    };
  }

  realpath(path: string): string {
    return realpathSync(confine(this.cwd, path));
  }

  unlink(path: string): void {
    unlinkSync(confine(this.cwd, path));
  }

  chmod(path: string, mode: number): void {
    chmodSync(confine(this.cwd, path), mode);
  }

  // Range read: same openSync/readSync/closeSync + confine()
  // technique as the file bridge — one chunk of memory, not the file.
  readFileRange(path: string, start: number, end: number): Uint8Array {
    const handle = openSync(confine(this.cwd, path), 'r');
    try {
      const length = Math.max(0, end - start);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(handle, buffer, 0, length, start);
      return buffer.subarray(0, read);
    } finally {
      closeSync(handle);
    }
  }
}
