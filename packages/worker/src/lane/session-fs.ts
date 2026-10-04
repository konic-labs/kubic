// Pi FileSystem over the exec file bridge (issue #14, slice A; Pi 1.0
// surface #392). Sync bridge calls wrapped async with node-error → FileError
// mapping. canonicalPath does not resolve symlinks (documented limitation —
// the session store never addresses symlinks). exists returns false for
// missing paths and maps other failures to FileError, per the contract.
//
// The 1.0 interface adds `id` (the file namespace), `truncateFile` (the JSONL
// core's torn-line recovery) and `flushFile` (its fsync seam). The adapter
// stays the only path between pi-durable's storage and the disk, so every
// session byte crosses the exec seam — I/O confinement (§9), the #359
// secret-scrubbing bridge and the #361 file modes all keep applying to
// session JSONL.

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

function toKind(info: {
  isDirectory: boolean;
  isSymbolicLink: boolean;
}): 'symlink' | 'directory' | 'file' {
  if (info.isSymbolicLink) return 'symlink';
  return info.isDirectory ? 'directory' : 'file';
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
  // The bridge is a local Node filesystem by construction (it is built on
  // node:fs), so it reports the one local namespace id pi-durable's own
  // NodeExecutionEnv reports: equal ids see the same files at the same paths.
  const notSupported = (path: string, method: string): FileError =>
    new FileError(
      'not_supported',
      `the exec file bridge does not implement ${method}`,
      path,
    );
  return {
    id: 'node:local',
    cwd: bridge.cwd,
    absolutePath: async (path: string, _context: Context) =>
      ok(bridge.absolutePath(path)),
    joinPath: async (parts: string[], _context: Context) =>
      ok(bridge.joinPath(parts)),
    readTextFile: async (path: string, _context: Context) =>
      attempt(path, () => bridge.readTextFile(path)),
    // Pi FileSystem surface (issue #71): pull-based line reading with
    // final-line termination preserved so a JSONL reader can discard a torn
    // trailing record. Computed from a single readTextFile snapshot — session
    // files are small and this keeps Pi types out of the exec bridge.
    // (Upstream does not re-export TextLine/TextLineReader from the package
    // index, so the shape flows structurally through FileSystem.)
    openTextLineReader: async (path: string, _context: Context) => {
      try {
        const text = bridge.readTextFile(path);
        const terminated = text.endsWith('\n');
        const parts = text.split('\n');
        if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
        const lines = parts.map((line, index) => ({
          text: line,
          terminated: index < parts.length - 1 || terminated,
        }));
        let cursor = 0;
        return ok({
          readLine: async (
            _context: Context,
          ): Promise<
            Result<{ text: string; terminated: boolean } | undefined, FileError>
          > => ok(cursor < lines.length ? lines[cursor++] : undefined),
          // Best-effort release: snapshot reader holds no handle.
          close: async (_context: Context): Promise<void> => undefined,
        });
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
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
    ) =>
      // Issue #361: session state is private — 0600 at creation (an existing
      // file keeps its own mode).
      attempt(path, () => bridge.writeFile(path, content, { mode: 0o600 })),
    appendFile: async (
      path: string,
      content: string | Uint8Array,
      _context: Context,
    ) => attempt(path, () => bridge.appendFile(path, content, { mode: 0o600 })),
    // Torn-line recovery (issue #392): the JSONL core truncates a partial
    // trailing record before it parses, so a crash mid-append costs the
    // newest commit and never the session.
    truncateFile: async (path: string, size: number, _context: Context) => {
      const truncate = bridge.truncateFile?.bind(bridge);
      if (truncate === undefined)
        return err(notSupported(path, 'truncateFile'));
      return attempt(path, () => truncate(path, size));
    },
    // The fsync seam (issue #392). A bridge that cannot flush refuses by
    // name rather than reporting a durability it did not deliver.
    flushFile: async (path: string, _context: Context) => {
      const flush = bridge.flushFile?.bind(bridge);
      if (flush === undefined) return err(notSupported(path, 'flushFile'));
      return attempt(path, () => flush(path));
    },
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
          kind: toKind(info),
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
      }),
    listDir: async (path: string, _context: Context) =>
      attempt(path, () =>
        bridge.listDir(path).map((info) => ({
          name: info.name,
          path: info.path,
          kind: toKind(info),
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
      attempt('<tempdir>', () => bridge.createTempDir(prefix)),
    createTempFile: async (
      options: { prefix?: string; suffix?: string } | undefined,
      _context: Context,
    ) =>
      attempt('<tempfile>', () =>
        bridge.createTempFile(options?.prefix, options?.suffix),
      ),
    cleanup: async (_context: Context): Promise<void> => undefined,
  };
}
