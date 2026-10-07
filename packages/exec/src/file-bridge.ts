// Node file bridge: exec-owned durable file access.
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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
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
   * a writer opens it.
   * Optional so existing fake bridges stay valid; `undefined` means "assume a
   * regular file", which is what a synthetic entry intends.
   */
  isFile?: boolean;
  /**
   * Permission bits of the path itself (lstat: never the link target's),
   * setuid/setgid/sticky included. Optional so existing
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
   * Read `[start, end)` bytes. Optional so existing bridges stay
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
  /**
   * Append, creating the file with `mode` when it does not exist (the journal
   * index and the session JSONL are private state, and `mode` is applied only
   * at creation — an existing file keeps its own).
   */
  appendFile(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number },
  ): void;
  /**
   * Append with fsync: the change journal's crash-safety seam.
   * The content is on platter before the call returns — an index append a
   * crash can lose or truncate is exactly the failure the journal exists to
   * prevent. Optional so existing test doubles stay valid; the journal falls
   * back to `appendFile` when a bridge does not implement it, and its
   * `durable` retention knob can opt out of the fsync cost explicitly.
   */
  appendDurably?(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number },
  ): void;
  /**
   * Truncate (or extend) a file to exactly `size` bytes: the
   * pi-durable JSONL storage core drops a torn trailing record with this on
   * recovery, so a crash mid-append is recovered instead of poisoning the
   * session. Optional so existing test doubles stay valid; a bridge without
   * it surfaces as a `not_supported` FileError at the session seam.
   */
  truncateFile?(path: string, size: number): void;
  /**
   * Flush a file's contents and the metadata needed to read them back: the
   * session storage's fsync seam. Kubic opens its sessions without it (the
   * journal is the fsync'd store — see docs/packages/worker.md), so this exists
   * for a caller that asks for durability explicitly. Optional like the rest.
   */
  flushFile?(path: string): void;
  /**
   * fsync a directory: a rename is atomic, but its directory
   * entry is durable only once the directory itself is flushed. The journal
   * flushes the blob directory after renaming a blob into place, and the
   * journal directory after renaming a rewritten index over the old one, so
   * a power loss cannot roll either name back. Optional like the rest; a
   * bridge without it keeps rename atomicity without rename durability.
   */
  flushDir?(path: string): void;
  renameFile(source: string, destination: string): void;
  /**
   * Set a path's permission bits: the seam that lets a
   * tmp+rename restore keep the target's own mode (a 0600 secret stays 0600,
   * a 755 script keeps its exec bit) instead of inheriting the tmp's.
   * Optional so existing test doubles stay valid; a bridge without it leaves
   * the restore's restrictive creation mode in place — never a wider one.
   */
  chmod?(path: string, mode: number): void;
  fileInfo(path: string): BridgeFileInfo;
  listDir(path: string): BridgeFileInfo[];
  exists(path: string): boolean;
  /**
   * Canonical absolute path (symlinks resolved; compares a
   * session's recorded cwd with the invocation cwd). Optional so test
   * doubles stay valid; throws when the path does not exist.
   */
  realPath?(path: string): string;
  createDir(path: string, recursive?: boolean, mode?: number): void;
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
    // Permission bits only: the file-type bits are not
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
  const ensureParent = (abs: string, mode?: number): void => {
    // `mode` is for state directories (0700) and applies only to
    // directories this call creates; a workspace write keeps the umask
    // default, because a user's new directory is not Kubic's to make private.
    if (mode === undefined) {
      mkdirSync(dirname(abs), { recursive: true });
      return;
    }
    mkdirSync(dirname(abs), { recursive: true, mode });
  };
  return {
    cwd,
    absolutePath,
    joinPath: (parts: string[]): string => join(...parts),
    readTextFile: (path: string): string =>
      readFileSync(absolutePath(path), 'utf8'),
    readBinaryFile: (path: string): Uint8Array =>
      readFileSync(absolutePath(path)),
    // Range read: the journal hashes large files in chunks so a
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
      ensureParent(abs, options?.mode);
      // Creation mode: `writeFileSync`'s mode only
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
    appendFile: (
      path: string,
      content: string | Uint8Array,
      options?: { mode?: number },
    ): void => {
      const abs = absolutePath(path);
      ensureParent(abs, options?.mode);
      if (options?.mode === undefined) {
        appendFileSync(abs, content);
        return;
      }
      appendFileSync(abs, content, { mode: options.mode });
    },
    // Durable append: one fd, one write, one fsync — the line
    // is on platter before the call returns. `writeSync` may write short on
    // some platforms, so the loop keeps writing until every byte is out;
    // fsync then covers the whole append. Directory-entry durability of the
    // file's own creation is deliberately out of scope (rename atomicity is
    // the journal's write guarantee — see docs/architecture).
    appendDurably: (
      path: string,
      content: string | Uint8Array,
      options?: { mode?: number },
    ): void => {
      const abs = absolutePath(path);
      ensureParent(abs, options?.mode);
      const fd =
        options?.mode === undefined
          ? openSync(abs, 'a')
          : openSync(abs, 'a', options.mode);
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
    truncateFile: (path: string, size: number): void => {
      truncateSync(absolutePath(path), size);
    },
    // A writable handle: every platform can flush one, and the JSONL core
    // only flushes files it just appended to. The directory entry of a
    // fresh file is deliberately out of scope, like appendDurably's.
    flushFile: (path: string): void => {
      const fd = openSync(absolutePath(path), 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    // Directory fsync: the rename's own durability. macOS and
    // Linux both allow opening a directory read-only and flushing it. A
    // platform that refuses either step surfaces the error, and the journal
    // treats an unsupported flush as a degraded write (rename atomicity
    // still holds) rather than blocking every append — see FLUSH_UNSUPPORTED
    // in journal.ts.
    flushDir: (path: string): void => {
      const fd = openSync(absolutePath(path), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    chmod: (path: string, mode: number): void => {
      chmodSync(absolutePath(path), mode);
    },
    fileInfo: (path: string): BridgeFileInfo => infoOf(absolutePath(path)),
    listDir: (path: string): BridgeFileInfo[] => {
      const abs = absolutePath(path);
      const out: BridgeFileInfo[] = [];
      for (const name of readdirSync(abs)) {
        try {
          out.push(infoOf(join(abs, name)));
        } catch (error) {
          // One entry vanishing between the listing and its lstat
          // must not fail the whole listing — the caller would drop the
          // entire subtree from the walk and read every file in it as
          // deleted. Only ENOENT is tolerated (the entry is simply gone); a
          // permission or I/O failure is the caller's to see.
          if ((error as { code?: string } | null)?.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      return out;
    },
    realPath: (path: string): string => realpathSync(absolutePath(path)),
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
    createDir: (path: string, recursive = true, mode?: number): void => {
      // `mode` (0700 for state dirs) applies only to directories
      // this call creates; existing ones keep their own.
      if (mode === undefined) {
        mkdirSync(absolutePath(path), { recursive });
        return;
      }
      mkdirSync(absolutePath(path), { recursive, mode });
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

// Run `run` while holding an O_EXCL lockfile: the seam for a
// mutation that must not interleave with another process's — the journal's
// append, retention rewrite and blob sweep all run under it. The lock file
// carries this process's pid, so a read-only observer can tell a live holder
// from stale residue (`liveLockHolder`). Same stale/wait rules as
// `updateFileLocked`: a crashed holder is stolen after `staleMs`, and a live
// one is waited for up to `waitMs` before the caller gets a named timeout.
// LOCAL FILESYSTEM ONLY, like every lock here.
export function withFileLocked<T>(
  lockPath: string,
  run: () => T,
  options: { staleMs?: number; waitMs?: number } = {},
): T {
  const staleMs = options.staleMs ?? 10_000;
  const deadline = Date.now() + (options.waitMs ?? 5_000);
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
      // The pid is for observers, not for the lock itself: the O_EXCL create
      // is the mutex. Written after the create so a torn payload can only
      // ever read as stale, never as held.
      try {
        writeSync(fd, Buffer.from(String(process.pid), 'utf8'));
      } catch (error) {
        // A failed pid write (ENOSPC/EIO) must not leak the descriptor or
        // leave the lock behind: the caller is about to rethrow, and this
        // process would otherwise hold a lock nobody can steal for staleMs.
        closeSync(fd);
        fd = undefined;
        rmSync(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // the holder released between open and stat
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return run();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

// The pid recorded in a lockfile when that process is still alive: the
// read-only view a destructive command uses to skip work instead of racing a
// live writer. undefined for a missing, unreadable, torn or stale file — and
// for a pid that is gone, which is exactly what makes a crashed holder's
// residue harmless.
export function liveLockHolder(lockPath: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return undefined;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    // Signal 0: the permission and existence probe, no signal delivered.
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

// Atomic, serialized update of one small state file (the trust store): an
// O_EXCL lockfile (stale after `staleMs`, so a crashed
// holder never wedges the next run) guards a read → update → tmp+rename
// write. The update sees the file as it is AT WRITE TIME, never a snapshot
// taken before an await. `current` is undefined only when the file is absent.
export function updateFileLocked(
  absPath: string,
  update: (current: string | undefined) => string,
  options: { staleMs?: number; waitMs?: number } = {},
): void {
  mkdirSync(dirname(absPath), { recursive: true });
  withFileLocked(
    `${absPath}.lock`,
    () => {
      let current: string | undefined;
      try {
        current = readFileSync(absPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const next = update(current);
      const tmp = `${absPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        writeFileSync(tmp, next);
        renameSync(tmp, absPath);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    },
    options,
  );
}
