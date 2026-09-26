// Node file bridge (issue #14, slice A): exec-owned durable file access.
// All node:fs touching stays in this package (I/O confinement); Pi types
// never cross here. The worker adapts this bridge to Pi's FileSystem for
// JsonlSessionRepo — sync core wrapped async at the seam.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface BridgeFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /**
   * True only for regular files. False for FIFOs, sockets and device nodes,
   * which must never be read: a synchronous read of a named pipe blocks until
   * a writer opens it (issue #87 follow-up — a FIFO in the workspace wedged
   * baseline capture at boot, and no test timeout can fire on a sync block).
   * Optional so existing fake bridges stay valid; `undefined` means "assume a
   * regular file", which is what a synthetic entry intends.
   */
  isFile?: boolean;
  /**
   * Permission bits of the path itself (lstat: never the link target's),
   * setuid/setgid/sticky included (issue #117 review). Optional so existing
   * fake bridges stay valid; `undefined` means "mode unknown", and the
   * restore falls back to its restrictive creation mode rather than
   * guessing.
   */
  mode?: number;
  size: number;
  mtimeMs: number;
}

export interface BridgeLineReader {
  readLine(): string | undefined;
  close(): void;
}

export interface FileBridge {
  readonly cwd: string;
  absolutePath(path: string): string;
  joinPath(parts: string[]): string;
  readTextFile(path: string): string;
  readBinaryFile(path: string): Uint8Array;
  /**
   * Read `[start, end)` bytes (issue #107). Optional so existing bridges stay
   * valid; when absent the journal falls back to whole-file reads, which is
   * correct-but-unbounded. The node bridge implements it, so every production
   * walk is bounded.
   */
  readFileRange?(path: string, start: number, end: number): Uint8Array;
  readTextLines(path: string, maxLines?: number): string[];
  openTextLineReader(path: string): BridgeLineReader;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number },
  ): void;
  appendFile(path: string, content: string | Uint8Array): void;
  /**
   * Append with fsync (issue #117): the change journal's crash-safety seam.
   * The content is on platter before the call returns — an index append a
   * crash can lose or truncate is exactly the failure the journal exists to
   * prevent. Optional so existing test doubles stay valid; the journal falls
   * back to `appendFile` when a bridge does not implement it, and its
   * `durable` retention knob can opt out of the fsync cost explicitly.
   */
  appendDurably?(path: string, content: string | Uint8Array): void;
  renameFile(source: string, destination: string): void;
  /**
   * Set a path's permission bits (issue #117 review): the seam that lets a
   * tmp+rename restore keep the target's own mode (a 0600 secret stays 0600,
   * a 755 script keeps its exec bit) instead of inheriting the tmp's.
   * Optional so existing test doubles stay valid; a bridge without it leaves
   * the restore's restrictive creation mode in place — never a wider one.
   */
  chmod?(path: string, mode: number): void;
  fileInfo(path: string): BridgeFileInfo;
  listDir(path: string): BridgeFileInfo[];
  exists(path: string): boolean;
  createDir(path: string, recursive?: boolean): void;
  remove(path: string, recursive?: boolean, force?: boolean): void;
  createTempDir(prefix?: string): string;
  createTempFile(prefix?: string, suffix?: string): string;
}

function infoOf(abs: string): BridgeFileInfo {
  // lstat: never follow symlinks (Pi FileInfo reports the link itself).
  const stat = lstatSync(abs);
  return {
    name: basename(abs),
    path: abs,
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    isFile: stat.isFile(),
    // Permission bits only (issue #117 review): the file-type bits are not
    // a mode, and a symlink's own bits (0777 on every platform) must stay
    // distinguishable from a real file's.
    mode: stat.mode & 0o7777,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function splitLines(text: string): string[] {
  // A trailing newline terminates the last line; it is not a phantom entry.
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32) || 'tmp-';
}

export function createNodeFileBridge(cwd: string): FileBridge {
  const absolutePath = (path: string): string => resolve(cwd, path);
  const ensureParent = (abs: string): void => {
    mkdirSync(dirname(abs), { recursive: true });
  };
  return {
    cwd,
    absolutePath,
    joinPath: (parts: string[]): string => join(...parts),
    readTextFile: (path: string): string =>
      readFileSync(absolutePath(path), 'utf8'),
    readBinaryFile: (path: string): Uint8Array =>
      readFileSync(absolutePath(path)),
    // Range read (issue #107): the journal hashes large files in chunks so a
    // 256MB artifact costs one chunk of memory, not 256MB.
    readFileRange: (path: string, start: number, end: number): Uint8Array => {
      const handle = openSync(absolutePath(path), 'r');
      try {
        const length = Math.max(0, end - start);
        const buffer = Buffer.allocUnsafe(length);
        const read = readSync(handle, buffer, 0, length, start);
        return buffer.subarray(0, read);
      } finally {
        closeSync(handle);
      }
    },
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = splitLines(readFileSync(absolutePath(path), 'utf8'));
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string): BridgeLineReader => {
      const lines = splitLines(readFileSync(absolutePath(path), 'utf8'));
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (
      path: string,
      content: string | Uint8Array,
      options?: { mode?: number },
    ): void => {
      const abs = absolutePath(path);
      ensureParent(abs);
      // Creation mode (issue #117 review): `writeFileSync`'s mode only
      // applies when the file is created, which is exactly what the restore
      // tmp needs (0600 so crash residue is never world-readable). Omitted
      // entirely when no mode is asked for, so every pre-existing caller
      // keeps the platform default.
      if (options?.mode === undefined) {
        writeFileSync(abs, content);
        return;
      }
      writeFileSync(abs, content, { mode: options.mode });
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const abs = absolutePath(path);
      ensureParent(abs);
      appendFileSync(abs, content);
    },
    // Durable append (issue #117): one fd, one write, one fsync — the line
    // is on platter before the call returns. `writeSync` may write short on
    // some platforms, so the loop keeps writing until every byte is out;
    // fsync then covers the whole append. Directory-entry durability of the
    // file's own creation is deliberately out of scope (rename atomicity is
    // the journal's write guarantee — see docs/architecture).
    appendDurably: (path: string, content: string | Uint8Array): void => {
      const abs = absolutePath(path);
      ensureParent(abs);
      const fd = openSync(abs, 'a');
      try {
        const buffer =
          typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        let offset = 0;
        while (offset < buffer.length) {
          offset += writeSync(fd, buffer, offset);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    renameFile: (source: string, destination: string): void => {
      renameSync(absolutePath(source), absolutePath(destination));
    },
    chmod: (path: string, mode: number): void => {
      chmodSync(absolutePath(path), mode);
    },
    fileInfo: (path: string): BridgeFileInfo => infoOf(absolutePath(path)),
    listDir: (path: string): BridgeFileInfo[] =>
      readdirSync(absolutePath(path)).map((name) =>
        infoOf(join(absolutePath(path), name)),
      ),
    exists: (path: string): boolean => {
      try {
        lstatSync(absolutePath(path));
        return true;
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT')
          return false;
        throw error;
      }
    },
    createDir: (path: string, recursive = true): void => {
      mkdirSync(absolutePath(path), { recursive });
    },
    remove: (path: string, recursive = false, force = false): void => {
      rmSync(absolutePath(path), { recursive, force });
    },
    createTempDir: (prefix = 'tmp-'): string =>
      mkdtempSync(join(tmpdir(), sanitizePrefix(prefix))),
    createTempFile: (prefix = '', suffix = ''): string => {
      // Directly under tmpdir (no leaked directory); O_EXCL loop so the
      // name is never predictable-clobberable.
      const clean = sanitizePrefix(prefix || 'file-');
      const tail = (suffix || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 16);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = join(
          tmpdir(),
          `${clean}${process.pid}-${attempt}${tail}`,
        );
        try {
          const fd = openSync(candidate, 'wx');
          closeSync(fd);
          return candidate;
        } catch (error) {
          if ((error as { code?: string } | null)?.code !== 'EEXIST')
            throw error;
        }
      }
      throw new Error('could not create a unique temp file');
    },
  };
}
