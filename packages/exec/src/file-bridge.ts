// Node file bridge (issue #14, slice A): exec-owned durable file access.
// All node:fs touching stays in this package (I/O confinement); Pi types
// never cross here. The worker adapts this bridge to Pi's FileSystem for
// JsonlSessionRepo — sync core wrapped async at the seam.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface BridgeFileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
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
  const stat = statSync(abs);
  const parts = abs.split('/');
  return {
    name: parts[parts.length - 1] ?? abs,
    path: abs,
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function createNodeFileBridge(cwd: string): FileBridge {
  const absolutePath = (path: string): string => resolve(cwd, path);
  return {
    cwd,
    absolutePath,
    joinPath: (parts: string[]): string => join(...parts),
    readTextFile: (path: string): string =>
      readFileSync(absolutePath(path), 'utf8'),
    readBinaryFile: (path: string): Uint8Array =>
      readFileSync(absolutePath(path)),
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = readFileSync(absolutePath(path), 'utf8').split('\n');
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string): BridgeLineReader => {
      const lines = readFileSync(absolutePath(path), 'utf8').split('\n');
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      writeFileSync(absolutePath(path), content);
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      appendFileSync(absolutePath(path), content);
    },
    renameFile: (source: string, destination: string): void => {
      renameSync(absolutePath(source), absolutePath(destination));
    },
    fileInfo: (path: string): BridgeFileInfo => infoOf(absolutePath(path)),
    listDir: (path: string): BridgeFileInfo[] =>
      readdirSync(absolutePath(path)).map((name) =>
        infoOf(join(absolutePath(path), name)),
      ),
    exists: (path: string): boolean => existsSync(absolutePath(path)),
    createDir: (path: string, recursive = true): void => {
      mkdirSync(absolutePath(path), { recursive });
    },
    remove: (path: string, recursive = false, force = false): void => {
      rmSync(absolutePath(path), { recursive, force });
    },
    createTempDir: (prefix = 'tmp-'): string =>
      mkdtempSync(join(tmpdir(), prefix)),
    createTempFile: (prefix = '', suffix = ''): string => {
      const dir = mkdtempSync(join(tmpdir(), 'file-'));
      const file = join(dir, `${prefix}tmp${suffix}`);
      writeFileSync(file, '');
      return file;
    },
  };
}
