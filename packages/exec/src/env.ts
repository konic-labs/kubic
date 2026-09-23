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
// Slice C (next): replay declarations, EffectGate, ToolBatch machine.

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
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
    let stdout = '';
    let stderr = '';
    const snapshot = (): ProcessSnapshot => ({
      stdout,
      stderr,
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
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      emit(false);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      emit(false);
    });
    const done = new Promise<ShellResult>((resolveDone) => {
      child.on('close', (code) => {
        const result: ShellResult = {
          exitCode: code ?? 1,
          stdout,
          stderr,
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
    listDir: () => [...this.files.keys()],
    stat: (path: string) => {
      const hit = this.files.get(path);
      if (hit === undefined) throw new Error(`fake fs: no such file: ${path}`);
      return { isFile: true, isDirectory: false, size: hit.length };
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
