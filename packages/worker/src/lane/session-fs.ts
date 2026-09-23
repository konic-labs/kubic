// Pi FileSystem over the exec file bridge (issue #14, slice A).
// Sync bridge calls wrapped async with node-error → FileError mapping.
// canonicalPath does not resolve symlinks (documented limitation — the
// session store never addresses symlinks). exists returns false for
// missing paths and maps other failures to FileError, per the contract.

import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  type Context,
  err,
  FileError,
  type FileErrorCode,
  type FileSystem,
  ok,
  type Result,
} from '../pi-boundary.js';

function toFileError(error: unknown, path: string): FileError {
  const code = (error as { code?: string } | null)?.code;
  let fileCode: FileErrorCode = 'unknown';
  if (code === 'ENOENT') fileCode = 'not_found';
  else if (code === 'EACCES' || code === 'EPERM')
    fileCode = 'permission_denied';
  else if (code === 'ENOTDIR') fileCode = 'not_directory';
  else if (code === 'EISDIR') fileCode = 'is_directory';
  else if (code === 'EINVAL') fileCode = 'invalid';
  const message = error instanceof Error ? error.message : String(error);
  return new FileError(
    fileCode,
    message,
    path,
    error instanceof Error ? error : undefined,
  );
}

export function bridgeToPiFileSystem(bridge: FileBridge): FileSystem {
  const attempt = async <T>(
    path: string,
    fn: () => T,
  ): Promise<Result<T, FileError>> => {
    try {
      return ok(fn());
    } catch (error) {
      return err(toFileError(error, path));
    }
  };
  return {
    cwd: bridge.cwd,
    absolutePath: async (path: string, _context: Context) =>
      ok(bridge.absolutePath(path)),
    joinPath: async (parts: string[], _context: Context) =>
      ok(bridge.joinPath(parts)),
    readTextFile: async (path: string, _context: Context) =>
      attempt(path, () => bridge.readTextFile(path)),
    readTextLines: async (
      path: string,
      options: { maxLines?: number } | undefined,
      _context: Context,
    ) => attempt(path, () => bridge.readTextLines(path, options?.maxLines)),
    readBinaryFile: async (path: string, _context: Context) =>
      attempt(path, () => bridge.readBinaryFile(path)),
    writeFile: async (
      path: string,
      content: string | Uint8Array,
      _context: Context,
    ) => attempt(path, () => bridge.writeFile(path, content)),
    appendFile: async (
      path: string,
      content: string | Uint8Array,
      _context: Context,
    ) => attempt(path, () => bridge.appendFile(path, content)),
    renameFile: async (
      sourcePath: string,
      destinationPath: string,
      _context: Context,
    ) =>
      attempt(sourcePath, () => bridge.renameFile(sourcePath, destinationPath)),
    fileInfo: async (path: string, _context: Context) =>
      attempt(path, () => {
        const info = bridge.fileInfo(path);
        return {
          name: info.name,
          path: info.path,
          kind: (info.isDirectory ? 'directory' : 'file') as
            | 'directory'
            | 'file',
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
      }),
    listDir: async (path: string, _context: Context) =>
      attempt(path, () =>
        bridge.listDir(path).map((info) => ({
          name: info.name,
          path: info.path,
          kind: (info.isDirectory ? 'directory' : 'file') as
            | 'directory'
            | 'file',
          size: info.size,
          mtimeMs: info.mtimeMs,
        })),
      ),
    canonicalPath: async (path: string, _context: Context) =>
      ok(bridge.absolutePath(path)),
    exists: async (path: string, _context: Context) => {
      try {
        return ok(bridge.exists(path));
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    createDir: async (
      path: string,
      options: { recursive?: boolean } | undefined,
      _context: Context,
    ) => attempt(path, () => bridge.createDir(path, options?.recursive)),
    remove: async (
      path: string,
      options: { recursive?: boolean; force?: boolean } | undefined,
      _context: Context,
    ) =>
      attempt(path, () =>
        bridge.remove(path, options?.recursive, options?.force),
      ),
    createTempDir: async (prefix: string | undefined, _context: Context) =>
      ok(bridge.createTempDir(prefix)),
    createTempFile: async (
      options: { prefix?: string; suffix?: string } | undefined,
      _context: Context,
    ) => ok(bridge.createTempFile(options?.prefix, options?.suffix)),
    cleanup: async (_context: Context): Promise<void> => undefined,
  };
}
