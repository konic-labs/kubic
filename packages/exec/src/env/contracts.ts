// The execution seam every tool runs through: the file system, the shell and
// the provenance a change is recorded under.
export interface Provenance {
  sessionId: string;
  agentId: string;
  toolCallId: string;
  turnId: number;
  operation: string;
}

export const ROOT_PROVENANCE: Provenance = {
  sessionId: '',
  agentId: '',
  toolCallId: 'root',
  turnId: 0,
  operation: 'init',
};

export interface StatInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  /** Permission bits (`st_mode & 0o7777`); absent on seams without modes. */
  mode?: number;
}

export interface FileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  listDir(path: string): string[];
  stat(path: string): StatInfo;
  /**
   * Symlink-aware stat. `stat()` follows links, so a walk
   * cannot tell a symlinked directory from a real one and would descend a
   * loop, returning the same files under every route. `lstat()` lets the
   * walk skip links entirely (a dangling one included, instead of throwing).
   * Optional so existing seams stay valid; absent = links cannot be told
   * apart from their targets (test doubles, and the documented widening).
   */
  lstat?(path: string): StatInfo & { isSymbolicLink: boolean };
  /**
   * Read `[start, end)` bytes (mirrors the FileBridge seam).
   * Optional so existing seams stay valid; absent = whole-file reads only
   * (test doubles). The node seam implements it, so every production read
   * windowing is bounded.
   */
  readFileRange?(path: string, start: number, end: number): Uint8Array;
  /**
   * The physical path `path` names — every symlink resolved.
   * `stat` follows links but only reports a target; a writer needs the
   * location the OS would actually open, so a tmp+rename lands beside the
   * real file instead of replacing the link with a regular file. The
   * lexical path is confined first; the RESULT is not (a link inside the
   * workspace may point out — the caller decides: the agent's file tools
   * refuse such a path as `symlink_escape`, writes and reads alike). Throws
   * when the path does not exist.
   * Optional so existing seams stay valid; absent = links resolve to
   * themselves (test doubles).
   */
  realpath?(path: string): string;
  /**
   * Remove a file: the tmp+rename writer's cleanup of the tmp
   * a failed write or rename left behind. Optional (test doubles have no
   * cleanup): absent = a failed write leaves its tmp for the operator.
   */
  unlink?(path: string): void;
  /**
   * Set permission bits. Optional (test doubles have no modes): tmp+rename
   * writers copy the replaced file's mode onto the tmp, so an overwrite
   * never strips a script's exec bit or widens a 0600 secret.
   */
  chmod?(path: string, mode: number): void;
}

export interface ShellResult {
  exitCode: number;
  /**
   * The signal the leader died from, when it was signalled:
   * `exitCode` already carries 128+signal; the name is kept so a report can
   * say SIGKILL rather than 137.
   */
  signal?: string | null;
  /**
   * The group SIGKILL escalation fired before the leader settled: the command's
   * own cooperative shutdown did not finish inside the kill grace, so it was
   * forced. Absent when no kill was requested or the leader settled on the
   * SIGTERM alone.
   */
  forced?: boolean;
  stdout: string;
  stderr: string;
  provenance: Provenance;
  /**
   * Set when processes of the command's group outlived the
   * leader. `killed` — the group was signalled (SIGTERM, then SIGKILL
   * after KILL_GRACE_MS) before settling; `detached` — the caller opted
   * into keeping background jobs, so they were left running. Absent when
   * nothing outlived the leader.
   */
  background?: 'killed' | 'detached';
}

export interface ProcessSnapshot {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /**
   * How many characters (UTF-16 code units) the capped
   * accumulators have dropped from the head of each stream so far. Past the
   * cap a snapshot keeps its length while its head moves, so a reader that
   * follows a stream (the agent fact scanner) needs this to find where the
   * new output starts. Absent means nothing was dropped.
   */
  dropped?: { stdout: number; stderr: number };
}

export interface CheckpointStore {
  record(key: string, snapshot: ProcessSnapshot): void;
  recordFinal(key: string, snapshot: ProcessSnapshot): void;
  latest(key: string): ProcessSnapshot | undefined;
}

type UpdateCallback = (
  snapshot: ProcessSnapshot,
  options?: { checkpoint?: boolean },
) => void;

export interface SpawnOptions {
  provenance: Provenance;
  onUpdate?: UpdateCallback;
  checkpointKey?: string;
  checkpointStore?: CheckpointStore;
  /**
   * Per-stream output accumulation cap in bytes. The tail is
   * kept (endings usually carry the error) and the final result gains a
   * header naming the dropped leading bytes. Default: 10 MiB per stream —
   * a chatty child (`yes`, a verbose build) must not OOM the run. Measured
   * in bytes of the DECODED stream (invalid UTF-8 arrives as U+FFFD, which
   * costs 3 bytes) and trimmed on code-point boundaries, so a
   * CJK or emoji stream cannot admit 3-4x the cap and the kept tail never
   * starts with half a surrogate pair.
   */
  maxOutputBytes?: number;
  /**
   * Grace period between kill()'s SIGTERM and the SIGKILL escalation, in
   * milliseconds. A group that traps or ignores SIGTERM must still die —
   * kill() is the abort/timeout path, and without escalation wait() never
   * settles. Default: KILL_GRACE_MS.
   */
  killGraceMs?: number;
  /**
   * Leave processes the command backgrounded running after the
   * leader exits (they are detached, and outlive Kubic). Default false —
   * the whole group is signalled once the leader exits, so no orphans.
   */
  keepBackground?: boolean;
}

export interface ProcessHandle {
  pid: number | undefined;
  wait(): Promise<ShellResult>;
  kill(): void;
}

export interface Shell {
  spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle;
}

export interface ExecutionEnv {
  cwd: string;
  fs: FileSystem;
  shell: Shell;
  provenance: Provenance;
  withProvenance(next: Provenance): ExecutionEnv;
}
