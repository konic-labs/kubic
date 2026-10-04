// ExecutionEnv seam (issue #12, slice A; §9, §20.2, §3.7).
// Every tool runs through this seam — no tool imports node:fs/child_process
// directly (enforced by scripts/dep-lint.mjs: only packages/exec may).
// Solo has no isolation (§3.7): confinement here is a cwd guardrail against
// accidental escapes, not a sandbox boundary.
//
// Slice A: FileSystem + Shell interfaces, provenance on every result,
// NodeExecutionEnv (cwd-scoped), FakeExecutionEnv (hermetic tests).
// Slice B: streaming onUpdate, throttled change-gated checkpoints,
// recordFinal crash-resume read point, detached process-group kill.
// Slice C (replay declarations + tool-call machine) is NOT reimplemented
// here: the Pi harness owns the tool-call state machine
// (`planned → effect_pending → outcome_ready → completed`, `replay:
// "never" | "safe"`) and the admission gate. Kubic declares a policy per
// operation and hands it to the harness (§20.2; issue #97).

import { spawn } from 'node:child_process';
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
import { constants as osConstants } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
   * Symlink-aware stat (issue #172). `stat()` follows links, so a walk
   * cannot tell a symlinked directory from a real one and would descend a
   * loop, returning the same files under every route. `lstat()` lets the
   * walk skip links entirely (a dangling one included, instead of throwing).
   * Optional so existing seams stay valid; absent = links cannot be told
   * apart from their targets (test doubles, and the documented widening).
   */
  lstat?(path: string): StatInfo & { isSymbolicLink: boolean };
  /**
   * Read `[start, end)` bytes (issue #122; mirrors #107's FileBridge seam).
   * Optional so existing seams stay valid; absent = whole-file reads only
   * (test doubles). The node seam implements it, so every production read
   * windowing is bounded.
   */
  readFileRange?(path: string, start: number, end: number): Uint8Array;
  /**
   * The physical path `path` names — every symlink resolved (issue #140).
   * `stat` follows links but only reports a target; a writer needs the
   * location the OS would actually open, so a tmp+rename lands beside the
   * real file instead of replacing the link with a regular file. The
   * lexical path is confined first; the RESULT is not (a link inside the
   * workspace may point out — the caller decides, see `symlink_escape`
   * in the worker's write path). Throws when the path does not exist.
   * Optional so existing seams stay valid; absent = links resolve to
   * themselves (test doubles).
   */
  realpath?(path: string): string;
  /**
   * Remove a file (issue #140): the tmp+rename writer's cleanup of the tmp
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
   * The signal the leader died from, when it was signalled (issue #151):
   * `exitCode` already carries 128+signal, but the NAME is what a worker row
   * records so `kubic workers` can say SIGKILL rather than 137.
   */
  signal?: string | null;
  /**
   * The group SIGKILL escalation fired before the leader settled (issue
   * #249): the command's own cooperative shutdown did not finish inside the
   * kill grace, so it was forced. Absent when no kill was requested or the
   * leader settled on the SIGTERM alone.
   */
  forced?: boolean;
  stdout: string;
  stderr: string;
  provenance: Provenance;
  /**
   * Issue #339: set when processes of the command's group outlived the
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
}

export interface CheckpointStore {
  record(key: string, snapshot: ProcessSnapshot): void;
  recordFinal(key: string, snapshot: ProcessSnapshot): void;
  latest(key: string): ProcessSnapshot | undefined;
}

export type UpdateCallback = (
  snapshot: ProcessSnapshot,
  options?: { checkpoint?: boolean },
) => void;

export interface SpawnOptions {
  provenance: Provenance;
  onUpdate?: UpdateCallback;
  checkpointKey?: string;
  checkpointStore?: CheckpointStore;
  /**
   * Per-stream output accumulation cap in bytes (issue #121). The tail is
   * kept (endings usually carry the error) and the final result gains a
   * header naming the dropped leading bytes. Default: 10 MiB per stream —
   * a chatty child (`yes`, a verbose build) must not OOM the run. Measured
   * in bytes of the DECODED stream (invalid UTF-8 arrives as U+FFFD, which
   * costs 3 bytes) and trimmed on code-point boundaries (issue #354), so a
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
   * Issue #339: leave processes the command backgrounded running after the
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

function confine(cwd: string, path: string): string {
  // Lexical guardrail only: resolve() defeats `..` and absolute escapes but
  // does NOT resolve symlinks — a symlink inside the cwd can still point
  // out. Acceptable: solo has no isolation (§3.7), this is an accidental-
  // escape guard, not a sandbox boundary.
  const abs = resolve(cwd, path);
  if (abs === cwd || abs.startsWith(cwd + sep)) return abs;
  // Issue #140: the cwd itself may be reached through a symlink (macOS
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

class NodeFileSystem implements FileSystem {
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

  // Range read (issue #122): same openSync/readSync/closeSync + confine()
  // technique as #107's file bridge — one chunk of memory, not the file.
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

export const CHECKPOINT_INTERVAL_MS = 2000;

function encodeSnapshot(snapshot: ProcessSnapshot): string {
  return `${snapshot.exitCode ?? 'run'}|${snapshot.stdout.length}|${snapshot.stdout}|${snapshot.stderr}`;
}

// Durable recovery checkpoints (§20.4): at most every
// CHECKPOINT_INTERVAL_MS and only when the encoded snapshot changed.
// Clock is injectable so throttle behavior is unit-testable.
//
// Honest limit (issue #97): this store is the seam, not a wired product
// path — no production caller supplies one to SpawnOptions today, so a
// `kubic run`/`kubic orchestrate` invocation persists no checkpoint and
// nothing resumes from one. The in-memory store is what the exec/lane
// tests drive; crash recovery for a tool call is the harness's own
// pending-progress snapshot (§20.4).
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly snapshots = new Map<string, ProcessSnapshot>();
  private readonly lastWrite = new Map<
    string,
    { at: number; encoded: string }
  >();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(key: string, snapshot: ProcessSnapshot): void {
    const at = this.now();
    const encoded = encodeSnapshot(snapshot);
    const prev = this.lastWrite.get(key);
    if (
      prev &&
      (at - prev.at < CHECKPOINT_INTERVAL_MS || prev.encoded === encoded)
    )
      return;
    this.lastWrite.set(key, { at, encoded });
    this.snapshots.set(key, { ...snapshot });
  }

  recordFinal(key: string, snapshot: ProcessSnapshot): void {
    this.lastWrite.set(key, {
      at: this.now(),
      encoded: encodeSnapshot(snapshot),
    });
    this.snapshots.set(key, { ...snapshot });
  }

  latest(key: string): ProcessSnapshot | undefined {
    const hit = this.snapshots.get(key);
    return hit ? { ...hit } : undefined;
  }
}

// Default per-stream child-output accumulation cap (issue #121). Chosen
// far above any legitimate tool result (the model-facing cap is smaller
// still) but far below OOM territory: the accumulator is the thing the
// cap bounds, so the run can never hold a child's whole output in memory.
export const MAX_CHILD_OUTPUT_BYTES = 10 * 1024 * 1024;

// SIGTERM → SIGKILL escalation window for kill(): long enough for a
// well-behaved child to flush and exit, short enough that an abort never
// hangs on a child that ignores SIGTERM.
export const KILL_GRACE_MS = 2000;

// §3.8 "never inherit ambient authority": every child the exec seam spawns
// (the bash tool, host git calls) starts from this allowlist, never from
// kubic's whole environment — a provider API key in the parent must not be
// one `echo $X` away from the model. Aligned with the worker launch
// allowlist (packages/worker/src/lifecycle/env.ts), plus the POSIX session
// basics a shell tool needs. No SSH_AUTH_SOCK / credential helpers: those
// are authority, not environment.
export const TOOL_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TZ',
  'CI',
  'NO_COLOR',
  'CLICOLOR',
  // Git behavior, not authority: a user who turns off system git config
  // wants every spawned git child (tools and tests) to honor it.
  'GIT_CONFIG_NOSYSTEM',
  // Network reachability and trust roots (not credentials): tools behind
  // a corporate proxy or custom CA must keep working. Both spellings of
  // the proxy vars are conventional — and their VALUES are scrubbed of
  // userinfo before they reach a child (issue #366): a proxy URL's
  // `user:password@` is a credential the name does not reveal.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows process basics (keys compared case-insensitively there).
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
];

const ALLOWED_UPPER = new Set(TOOL_ENV_ALLOWLIST.map((k) => k.toUpperCase()));

// Issue #366: the proxy variables are allowlisted for reachability, but a
// proxy URL can carry userinfo — `http://user:password@proxy:3128` — which is
// a credential in the §3.8 sense even though the NAME looks benign, so
// `looksSecret` never sees it. §36.1 rule 2: a credential must never reach an
// agent-visible string, and the model's shell can read the child env. The
// value keeps its scheme, host and port and loses the userinfo; a proxy that
// REQUIRES that auth is therefore not usable from a tool child (Kubic does
// not broker proxy auth — see docs/architecture/journal-and-safety.md).
// Queried with the upper-cased key (Windows matches case-insensitively), so
// the set holds the upper-case names only.
const PROXY_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY']);

// The value without its userinfo: scheme and everything from the host on
// survive verbatim, so no URL parser normalization (a trailing slash, a
// lower-cased host) creeps into a value other tools must match byte for byte.
// The scheme is anchored at position 0: searching the whole value for '://'
// let a scheme-less value whose PATH contains '://' slice the authority out
// of the path and return the credential untouched (issue #366 review). The
// strip assumes a valid URL-shaped value; a raw '/' inside malformed
// userinfo still ends the authority early, exactly as `urlsplit` would.
const SCHEME_AT_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function stripProxyUserinfo(value: string): string {
  const scheme = SCHEME_AT_START.exec(value);
  const start = scheme === null ? 0 : scheme[0].length;
  let end = value.length;
  for (const separator of ['/', '?', '#']) {
    const at = value.indexOf(separator, start);
    if (at !== -1 && at < end) end = at;
  }
  const authority = value.slice(start, end);
  // The LAST '@' in the authority is the userinfo separator (an earlier one
  // belongs to percent-encoded userinfo).
  const at = authority.lastIndexOf('@');
  if (at === -1) return value;
  return `${value.slice(0, start)}${authority.slice(at + 1)}${value.slice(end)}`;
}

const SECRET_SUFFIXES = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'CREDENTIALS'];

function looksSecret(upper: string): boolean {
  return SECRET_SUFFIXES.some(
    (suffix) => upper === suffix || upper.endsWith(`_${suffix}`),
  );
}

// Pure: the allowlisted subset of `base` (plus LC_* / XDG_* vars). A
// secret-shaped name is dropped even if it matches a pattern (LC_*_KEY), and
// a proxy URL loses its userinfo (issue #366) — the one credential an
// allowlisted NAME could hide.
export function toolSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const allowed =
      (process.platform === 'win32'
        ? ALLOWED_UPPER.has(upper)
        : TOOL_ENV_ALLOWLIST.includes(key)) ||
      key.startsWith('LC_') ||
      key.startsWith('XDG_');
    if (!allowed || looksSecret(upper)) continue;
    out[key] = PROXY_VARS.has(upper) ? stripProxyUserinfo(value) : value;
  }
  return out;
}

// Issue #339: once the leader exits, pipe data it wrote is drained for at
// most this long. Anything still holding stdout/stderr after the window is
// a background job, never the command's own output, so the streams are
// destroyed instead of waiting for 'close' (which never comes while a
// backgrounded `sleep` inherits the pipe).
export const EXIT_DRAIN_MS = 150;

const GROUP_POLL_MS = 10;

// 128+signal, the shell convention (`kill -9 $$` → 137), instead of a
// flattening `code ?? 1` that makes a signal exit look like a plain error.
export function exitCodeFor(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal !== null) {
    const number = osConstants.signals[signal];
    if (typeof number === 'number') return 128 + number;
  }
  return 1;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Is the LEADER still a process? Asked of the OS, not of the child object:
// `exitCode`/`signalCode` are set when the 'exit' event is delivered, which
// can lag the process's actual death — and the delayed group SIGKILL this
// guards against (issue #142) is scheduled in exactly that window.
function leaderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already gone.
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(GROUP_POLL_MS);
  }
  return true;
}

// SIGTERM the group, escalate to SIGKILL after KILL_GRACE_MS, and wait
// until no member is left (bounded).
async function reapGroup(pgid: number, graceMs: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  if (await waitGroupGone(pgid, graceMs)) return;
  signalGroup(pgid, 'SIGKILL');
  await waitGroupGone(pgid, graceMs);
}

// UTF-8 byte length of a code point, computed without allocating a string
// for it (issue #354): the output accumulator trims on code-point
// boundaries, so it needs each code point's encoded size.
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

class NodeShell implements Shell {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle {
    // Detached process group: kill() signals the whole group so spawned
    // grandchildren die too (§9 leak cleanup) — no orphans.
    // Issue #339: stdin is 'ignore' — a stdin reader (cat, read -p, a
    // REPL, a commit hook) sees EOF at once instead of blocking the turn
    // on a pipe nobody ever ends.
    const groups = process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: this.cwd,
      detached: groups,
      // §3.8: an explicit allowlisted env, never the inherited one.
      env: toolSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Issue #121: capped accumulation. The tail is kept — endings carry
    // the error — and the final result names exactly what was dropped.
    // `peek` feeds progress snapshots (bounded by the same cap), `final`
    // produces the settled stream with the truncation header.
    //
    // Issue #354: the cap is documented in BYTES and must be measured in
    // bytes. Counting UTF-16 code units admitted up to ~3x the intended
    // memory for CJK text (one unit, three bytes), misstated the dropped
    // size, and let `slice(-cap)` start the kept tail with half a surrogate
    // pair — a lone low surrogate reaches the model, the trajectory and the
    // session store as U+FFFD. Bytes are the bound; code points are the trim
    // boundary.
    const cap = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    const makeAccumulator = () => {
      let text = '';
      let bytes = 0;
      let dropped = 0;
      return {
        push(chunk: string): void {
          const chunkBytes = Buffer.byteLength(chunk, 'utf8');
          if (bytes + chunkBytes <= cap) {
            text += chunk;
            bytes += chunkBytes;
            return;
          }
          const combined = text + chunk;
          const total = bytes + chunkBytes;
          const excess = total - cap;
          let at = 0;
          let drop = 0;
          while (drop < excess && at < combined.length) {
            const codePoint = combined.codePointAt(at) ?? 0;
            drop += utf8Length(codePoint);
            at += codePoint > 0xffff ? 2 : 1;
          }
          dropped += drop;
          text = combined.slice(at);
          bytes = total - drop;
        },
        peek(): string {
          return text;
        },
        final(): string {
          if (dropped === 0) return text;
          return `[kubic: output truncated — dropped ${dropped} leading bytes, kept the last ${bytes}]\n${text}`;
        },
      };
    };
    const stdoutAcc = makeAccumulator();
    const stderrAcc = makeAccumulator();
    // Issue #112: pipe chunks are arbitrary byte slices — Buffer.toString()
    // per chunk corrupts any multi-byte UTF-8 codepoint split across a
    // chunk boundary (U+FFFD on both sides). One StringDecoder per stream
    // carries split codepoints across writes; decoder.end() on settle
    // flushes a trailing incomplete sequence instead of dropping it.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let settled = false;
    // Issue #249: did the SIGKILL escalation beat the LEADER's own exit?
    // Derived from the leader, never from the handle settling: `finish()`
    // awaits the whole group drain, so a grandchild that outlives the
    // SIGTERM would otherwise report a cooperative settle as forced.
    let forced = false;
    let leaderExited = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = (): ProcessSnapshot => ({
      stdout: stdoutAcc.peek(),
      stderr: stderrAcc.peek(),
      exitCode: null,
    });
    const emit = (checkpoint: boolean) => {
      options.onUpdate?.(
        snapshot(),
        checkpoint ? { checkpoint: true } : undefined,
      );
      if (checkpoint && options.checkpointKey && options.checkpointStore) {
        options.checkpointStore.record(options.checkpointKey, snapshot());
      }
    };
    // A configured checkpoint store means this run wants durable recovery:
    // every update requests a checkpoint and the store's own gate
    // (≤2s, change-only) decides what is durable (§20.4).
    const wantCheckpoint =
      options.checkpointKey !== undefined &&
      options.checkpointStore !== undefined;
    child.stdout?.on('data', (d: Buffer) => {
      stdoutAcc.push(outDec.write(d));
      emit(wantCheckpoint);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrAcc.push(errDec.write(d));
      emit(wantCheckpoint);
    });
    const done = new Promise<ShellResult>((resolveDone) => {
      // A spawn that cannot start the child emits 'error' and never
      // 'close'. Unhandled, Node re-throws it as an uncaught exception and
      // the caller dies raw — no result, no exit code (issue #85: this is
      // the `spawn <path> ENOENT` crash). Settle wait() with a named
      // failure instead, so every caller reads it through the same seam.
      child.on('error', (error: Error) => {
        // A spawn error means no leader exists (issue #249): nothing to force.
        leaderExited = true;
        if (settled) return;
        settled = true;
        // Flush any buffered partial byte sequence before the result is
        // built — 'error' can fire with decoded-pending output too.
        stdoutAcc.push(outDec.end());
        stderrAcc.push(errDec.end());
        const message = `${error.message}\n`;
        stderrAcc.push(message);
        const result: ShellResult = {
          exitCode: 127,
          stdout: stdoutAcc.final(),
          stderr: stderrAcc.final(),
          provenance: options.provenance,
        };
        if (options.checkpointKey && options.checkpointStore) {
          options.checkpointStore.recordFinal(options.checkpointKey, {
            ...result,
          });
        }
        options.onUpdate?.({ ...result }, undefined);
        resolveDone(result);
      });
      // Issue #339: settle on the leader's 'exit' plus a short drain
      // window, not on 'close' — 'close' waits for every holder of the
      // pipes, and a backgrounded job inherits them. After the drain the
      // process group is reaped (unless keepBackground), so the tool never
      // returns with an orphan still running in the detached group.
      let leaderExit: number | undefined;
      let leaderSignal: NodeJS.Signals | null = null;
      let streamsClosed = false;
      let finishing = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = async () => {
        if (finishing || settled) return;
        finishing = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        // Issue #249 review: the group SIGKILL escalation belongs to a LIVE
        // leader. Once the handle settles, a pending timer could signal a
        // recycled pgid (the #142 stranger hazard) — the settle path reaps
        // the group itself.
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        const heldPipes = !streamsClosed;
        if (heldPipes) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        let background: ShellResult['background'];
        const pgid = child.pid;
        if (groups && pgid !== undefined && groupAlive(pgid)) {
          if (options.keepBackground === true) background = 'detached';
          else {
            background = 'killed';
            await reapGroup(pgid, options.killGraceMs ?? KILL_GRACE_MS);
          }
        } else if (heldPipes) {
          // A pipe holder that left the group (setsid) is out of reach.
          background = 'detached';
        }
        if (settled) return;
        settled = true;
        // Flush any trailing incomplete byte sequence (decoder.end() emits
        // it as U+FFFD, never throws) before the result is built.
        stdoutAcc.push(outDec.end());
        stderrAcc.push(errDec.end());
        if (background !== undefined) {
          stderrAcc.push(
            background === 'killed'
              ? '[kubic: background processes started by this command were killed after it exited (KUBIC_BASH_KEEP_BACKGROUND=1 keeps them)]\n'
              : '[kubic: background processes started by this command were left running, detached]\n',
          );
        }
        const result: ShellResult = {
          exitCode: leaderExit ?? 1,
          ...(leaderSignal === null ? {} : { signal: leaderSignal }),
          ...(forced ? { forced: true } : {}),
          stdout: stdoutAcc.final(),
          stderr: stderrAcc.final(),
          provenance: options.provenance,
          ...(background === undefined ? {} : { background }),
        };
        if (options.checkpointKey && options.checkpointStore) {
          options.checkpointStore.recordFinal(options.checkpointKey, {
            ...result,
          });
        }
        options.onUpdate?.({ ...result }, undefined);
        child.unref();
        resolveDone(result);
      };
      child.on('exit', (code, signal) => {
        // The leader is gone, whatever else the group is doing (issue #249):
        // recorded before the settle guard so a finishing handle still knows.
        leaderExited = true;
        if (settled || finishing) return;
        leaderExit = exitCodeFor(code, signal);
        leaderSignal = signal;
        if (streamsClosed) {
          void finish();
          return;
        }
        drainTimer = setTimeout(() => void finish(), EXIT_DRAIN_MS);
      });
      child.on('close', (code, signal) => {
        streamsClosed = true;
        if (settled || finishing) return;
        if (leaderExit === undefined) leaderExit = exitCodeFor(code, signal);
        void finish();
      });
    });
    return {
      pid: child.pid,
      wait: () => done,
      kill: () => {
        const pid = child.pid;
        if (pid === undefined) return;
        // A settled handle is finished: its pid (and group) may already be
        // recycled, and a background job it deliberately left running
        // (KUBIC_BASH_KEEP_BACKGROUND=1) is no longer this handle's to kill.
        if (settled) return;
        const signal = (sig: NodeJS.Signals): void => {
          try {
            if (process.platform !== 'win32') process.kill(-pid, sig);
            else child.kill(sig);
          } catch {
            try {
              child.kill(sig);
            } catch {
              // Already exited — nothing to kill.
            }
          }
        };
        signal('SIGTERM');
        // Escalate: a group that traps or ignores SIGTERM would otherwise
        // keep wait() pending forever. The timer is unref'd so it never
        // holds the event loop open, and it is a no-op once settled.
        // The group, not just the leader: a leader that exits on SIGTERM
        // settles the handle while group members that ignore it live on,
        // so the escalation is not gated on the leader surviving the grace.
        //
        // Issue #142: it IS gated on the leader being alive when kill() was
        // called (asked of the OS — see leaderAlive). A leader that has
        // already exited owns no process group any more — its pgid may be
        // recycled — so a delayed group SIGKILL could hit a stranger.
        // Nothing is orphaned by skipping it: the settle path reaps whatever
        // the group still holds (reapGroup, unless the caller opted into
        // keepBackground).
        if (!leaderAlive(pid)) return;
        escalationTimer = setTimeout(() => {
          // The leader is still up when the grace elapses: its cooperative
          // shutdown did not finish, so this is a FORCED kill (issue #249).
          // The LEADER's exit is the test — a group member that outlives the
          // SIGTERM is the escalation's cleanup, not a forced worker.
          if (!leaderExited) forced = true;
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // ESRCH: the whole group already exited.
            }
          } else if (!settled) signal('SIGKILL');
        }, options.killGraceMs ?? KILL_GRACE_MS);
        escalationTimer.unref();
      },
    };
  }
}

export class NodeExecutionEnv implements ExecutionEnv {
  readonly fs: FileSystem;
  readonly shell: Shell;
  readonly cwd: string;
  readonly provenance: Provenance;

  constructor(cwd: string, provenance: Provenance = ROOT_PROVENANCE) {
    this.cwd = cwd;
    this.provenance = provenance;
    this.fs = new NodeFileSystem(cwd);
    this.shell = new NodeShell(cwd);
  }

  withProvenance(next: Provenance): ExecutionEnv {
    return new NodeExecutionEnv(this.cwd, next);
  }
}

export interface FakeScript {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The fake's missing-path error carries Node's `ENOENT` code, so ops that
// map errno codes (read, issue #199) see the same shape as the real seam.
function fakeNoSuchFile(path: string): Error {
  return Object.assign(new Error(`fake fs: no such file: ${path}`), {
    code: 'ENOENT',
  });
}

export class FakeExecutionEnv implements ExecutionEnv {
  readonly cwd = '/fake';
  readonly provenance: Provenance;
  private readonly files = new Map<string, string>();
  private readonly scriptMap: Map<string, FakeScript>;

  readonly fs: FileSystem = {
    readFile: (path: string) => {
      const hit = this.files.get(path);
      if (hit === undefined) throw fakeNoSuchFile(path);
      return hit;
    },
    writeFile: (path: string, content: string) => {
      this.files.set(path, content);
    },
    rename: (from: string, to: string) => {
      const hit = this.files.get(from);
      if (hit === undefined) throw fakeNoSuchFile(from);
      this.files.delete(from);
      this.files.set(to, hit);
    },
    // Prefix filter approximating directory listing (first segment under
    // the path). Known divergence from Node semantics (no `.`/`..`
    // resolution) — the fake is a hermetic stand-in, not a fs model.
    listDir: (path: string) => {
      const prefix =
        path === '.' || path === '' ? '' : `${path.replace(/\/*$/, '')}/`;
      const out = new Set<string>();
      for (const key of this.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split('/')[0];
        if (seg) out.add(seg as string);
      }
      return [...out];
    },
    stat: (path: string) => {
      const hit = this.files.get(path);
      if (hit !== undefined)
        return { isFile: true, isDirectory: false, size: hit.length };
      const prefix = `${path.replace(/\/*$/, '')}/`;
      let size = 0;
      let count = 0;
      for (const [k, v] of this.files) {
        if (k.startsWith(prefix)) {
          size += v.length;
          count += 1;
        }
      }
      if (count === 0) throw fakeNoSuchFile(path);
      return { isFile: false, isDirectory: true, size };
    },
  };

  readonly shell: Shell = {
    spawn: (
      cmd: string,
      args: string[],
      options: SpawnOptions,
    ): ProcessHandle => {
      const key = `${cmd} ${args.join(' ')}`;
      const script = this.scriptMap.get(key) ?? {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      const snapshot: ProcessSnapshot = {
        stdout: script.stdout,
        stderr: script.stderr,
        exitCode: null,
      };
      return {
        pid: undefined,
        wait: () => {
          options.onUpdate?.(snapshot, undefined);
          if (options.checkpointKey && options.checkpointStore) {
            options.checkpointStore.recordFinal(options.checkpointKey, {
              ...snapshot,
              exitCode: script.exitCode,
            });
          }
          return Promise.resolve({
            exitCode: script.exitCode,
            stdout: script.stdout,
            stderr: script.stderr,
            provenance: options.provenance,
          });
        },
        kill: () => undefined,
      };
    },
  };

  constructor(
    scripts: Map<string, FakeScript> | Record<string, FakeScript>,
    provenance: Provenance = ROOT_PROVENANCE,
  ) {
    this.scriptMap =
      scripts instanceof Map ? scripts : new Map(Object.entries(scripts));
    this.provenance = provenance;
  }

  withProvenance(next: Provenance): ExecutionEnv {
    const scoped = new FakeExecutionEnv(this.scriptMap, next);
    for (const [k, v] of this.files) scoped.files.set(k, v);
    return scoped;
  }
}
