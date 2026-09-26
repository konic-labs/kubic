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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

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
}

export interface FileSystem {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  listDir(path: string): string[];
  stat(path: string): StatInfo;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  provenance: Provenance;
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
   * a chatty child (`yes`, a verbose build) must not OOM the run.
   */
  maxOutputBytes?: number;
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
  if (abs !== cwd && !abs.startsWith(cwd + sep)) {
    throw new Error(`path escapes cwd confinement: ${path}`);
  }
  return abs;
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
    };
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

class NodeShell implements Shell {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle {
    // Detached process group: kill() signals the whole group so spawned
    // grandchildren die too (§9 leak cleanup) — no orphans.
    const child = spawn(cmd, args, {
      cwd: this.cwd,
      detached: process.platform !== 'win32',
    });
    // Issue #121: capped accumulation. The tail is kept — endings carry
    // the error — and the final result names exactly what was dropped.
    // `peek` feeds progress snapshots (bounded by the same cap), `final`
    // produces the settled stream with the truncation header.
    const cap = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    const makeAccumulator = () => {
      let text = '';
      let dropped = 0;
      return {
        push(chunk: string): void {
          if (text.length + chunk.length <= cap) {
            text += chunk;
            return;
          }
          const combined = text + chunk;
          dropped += combined.length - cap;
          text = combined.slice(-cap);
        },
        peek(): string {
          return text;
        },
        final(): string {
          if (dropped === 0) return text;
          return `[kubic: output truncated — dropped ${dropped} leading bytes, kept the last ${text.length}]\n${text}`;
        },
      };
    };
    const stdoutAcc = makeAccumulator();
    const stderrAcc = makeAccumulator();
    let settled = false;
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
      stdoutAcc.push(d.toString());
      emit(wantCheckpoint);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrAcc.push(d.toString());
      emit(wantCheckpoint);
    });
    const done = new Promise<ShellResult>((resolveDone) => {
      // A spawn that cannot start the child emits 'error' and never
      // 'close'. Unhandled, Node re-throws it as an uncaught exception and
      // the caller dies raw — no result, no exit code (issue #85: this is
      // the `spawn <path> ENOENT` crash). Settle wait() with a named
      // failure instead, so every caller reads it through the same seam.
      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
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
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const result: ShellResult = {
          exitCode: code ?? 1,
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
        child.unref();
        resolveDone(result);
      });
    });
    return {
      pid: child.pid,
      wait: () => done,
      kill: () => {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid);
          else child.kill();
        } catch {
          try {
            child.kill();
          } catch {
            // Already exited — nothing to kill.
          }
        }
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

export class FakeExecutionEnv implements ExecutionEnv {
  readonly cwd = '/fake';
  readonly provenance: Provenance;
  private readonly files = new Map<string, string>();
  private readonly scriptMap: Map<string, FakeScript>;

  readonly fs: FileSystem = {
    readFile: (path: string) => {
      const hit = this.files.get(path);
      if (hit === undefined) throw new Error(`fake fs: no such file: ${path}`);
      return hit;
    },
    writeFile: (path: string, content: string) => {
      this.files.set(path, content);
    },
    rename: (from: string, to: string) => {
      const hit = this.files.get(from);
      if (hit === undefined) throw new Error(`fake fs: no such file: ${from}`);
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
      if (count === 0) throw new Error(`fake fs: no such file: ${path}`);
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
