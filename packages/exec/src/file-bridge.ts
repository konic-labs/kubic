// Node file bridge (issue #14, slice A): exec-owned durable file access.
// All node:fs touching stays in this package (I/O confinement); Pi types
// never cross here. The worker adapts this bridge to Pi's FileSystem for
// JsonlSessionRepo — sync core wrapped async at the seam.

import {
  appendFileSync,
  closeSync,
  readSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
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
  writeFile(path: string, content: string | Uint8Array): void;
  appendFile(path: string, content: string | Uint8Array): void;
  renameFile(source: string, destination: string): void;
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
    writeFile: (path: string, content: string | Uint8Array): void => {
      const abs = absolutePath(path);
      ensureParent(abs);
      writeFileSync(abs, content);
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const abs = absolutePath(path);
      ensureParent(abs);
      appendFileSync(abs, content);
    },
    renameFile: (source: string, destination: string): void => {
      renameSync(absolutePath(source), absolutePath(destination));
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
