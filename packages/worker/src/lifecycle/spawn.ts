// Worker process spawn (issue #42; §6.3, §13, §49.3): one OS process
// per subagent through the exec Shell seam — never node:child_process
// here (dep-lint: only packages/exec touches it). The env allowlist
// (§3.8) plus the role grant (§36.3) is the child's whole world; the
// readiness marker flips spawning→ready→running and its latency is the
// kubic.worker.startup span (§49.3, §61). No marker in time → terminal
// SPAWN_FAILED, never a half-live worker.

import type {
  ProcessHandle,
  Provenance,
  SpawnOptions,
} from '../../../exec/src/env.js';
import { buildSpawnEnv, redactEnvForLog } from './env.js';
import { StaleGenerationError } from './replace.js';
import type { WorkerStatus } from './status.js';

export const READY_PREFIX = 'KUBIC_WORKER_READY';

export function readyMarker(workerId: string): string {
  return `${READY_PREFIX} ${workerId}`;
}

// The exec Shell seam plus a spawn env: WorkerShell is structurally the
// exec Shell — FakeExecutionEnv and NodeExecutionEnv both satisfy it —
// with the child's filtered env carried alongside SpawnOptions. The
// composition root (not this module) decides how env reaches the OS.
export interface WorkerShell {
  spawn(
    cmd: string,
    args: string[],
    options: SpawnOptions & { env: Record<string, string> },
  ): ProcessHandle;
}

export interface SpawnWorkerRequest {
  workerId: string;
  sessionId: string;
  generation: number;
  role: string;
  cmd: string;
  args: string[];
  baseEnv: Record<string, string>;
  credentials?: Record<string, string>;
  provenance: Provenance;
  readyTimeoutMs?: number;
}

export interface SpawnWorkerDeps {
  clock?: () => number;
  onStartup?: (startupMs: number) => void;
  // Live generation for request.sessionId, when the caller tracks one
  // (e.g. the WorkerRegistry row). A request naming an older generation
  // is stale and refused before any side effect.
  getLiveGeneration?: (sessionId: string) => number | undefined;
  // Receives the redacted spawn debug line (see spawnDebugLine): secrets
  // are redacted by default, so wiring this to §50 output is safe.
  onDebug?: (line: string) => void;
}

export class SpawnFailedError extends Error {
  constructor(workerId: string, reason: string) {
    super(`spawn failed for worker ${workerId}: ${reason}`);
    this.name = 'SpawnFailedError';
  }
}

export interface SpawnedWorker {
  workerId: string;
  sessionId: string;
  generation: number;
  pid: number | undefined;
  status: WorkerStatus;
  // Redacted-for-log view of the child env (redactEnvForLog): keys stay
  // for debugging, secret values never do. The plaintext env reaches only
  // the exec Shell seam in spawn options — never this handle.
  env: Record<string, string>;
  startedAtMs: number;
  startupMs: number | undefined;
  ready: Promise<void>;
  wait: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill: () => void;
}

// The spawn debug line (§50 vocabulary): worker identity plus the child
// env with secrets redacted. Redaction is the default here — callers get
// no accessor to the plaintext grant, which lives only in the Shell seam.
export function spawnDebugLine(args: {
  workerId: string;
  sessionId: string;
  generation: number;
  pid: number | undefined;
  env: Record<string, string>;
}): string {
  const redacted = redactEnvForLog(args.env);
  const pid = args.pid === undefined ? '-' : String(args.pid);
  const envJson = JSON.stringify(redacted);
  return `[worker] spawn id=${args.workerId} session=${args.sessionId} gen=${String(args.generation)} pid=${pid} env=${envJson}`;
}

export { StaleGenerationError };

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function spawnWorker(
  shell: WorkerShell,
  request: SpawnWorkerRequest,
  deps?: SpawnWorkerDeps,
): SpawnedWorker {
  // A pre-replace generation must never spawn over a live worker: refuse
  // before any side effect (no env build, no shell spawn).
  const live = deps?.getLiveGeneration?.(request.sessionId);
  if (live !== undefined && request.generation < live) {
    throw new StaleGenerationError(request.sessionId, live, request.generation);
  }
  const clock = deps?.clock ?? Date.now;
  const startedAtMs = clock();
  const env = buildSpawnEnv(
    request.baseEnv,
    request.role,
    request.credentials ?? {},
  );
  const marker = readyMarker(request.workerId);
  const worker: SpawnedWorker = {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation: request.generation,
    pid: undefined,
    status: 'spawning',
    env: redactEnvForLog(env),
    startedAtMs,
    startupMs: undefined,
    ready: Promise.resolve(),
    wait: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    kill: () => undefined,
  };

  let settleReady!: () => void;
  let failReady!: (error: Error) => void;
  worker.ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });
  // A rejected readiness with no observer yet is still a failure the
  // caller handles via worker.ready — mark handled so the timeout path
  // below never fires an unhandled rejection.
  worker.ready.catch(() => undefined);

  const finishReady = (): void => {
    if (worker.status !== 'spawning') return;
    clearTimeout(timer);
    worker.startupMs = clock() - startedAtMs;
    worker.status = 'running';
    deps?.onStartup?.(worker.startupMs);
    settleReady();
  };

  const failSpawn = (reason: string): void => {
    if (worker.status !== 'spawning') return;
    worker.status = 'spawn_failed';
    try {
      handle.kill();
    } catch {
      // Already gone — the status above is the report.
    }
    failReady(new SpawnFailedError(request.workerId, reason));
  };

  const timeoutMs = request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const timer = setTimeout(
    () => failSpawn(`readiness marker not seen within ${timeoutMs}ms`),
    timeoutMs,
  );

  let handle: ProcessHandle;
  try {
    handle = shell.spawn(request.cmd, request.args, {
      provenance: request.provenance,
      env,
      onUpdate: (snapshot) => {
        const text = `${snapshot.stdout}\n${snapshot.stderr}`;
        if (text.includes(marker)) {
          clearTimeout(timer);
          finishReady();
        }
      },
    });
  } catch (error) {
    clearTimeout(timer);
    worker.status = 'spawn_failed';
    failReady(
      error instanceof Error
        ? error
        : new SpawnFailedError(request.workerId, String(error)),
    );
    worker.wait = () =>
      worker.ready.then(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    worker.kill = () => undefined;
    return worker;
  }
  worker.pid = handle.pid;
  deps?.onDebug?.(
    spawnDebugLine({
      workerId: request.workerId,
      sessionId: request.sessionId,
      generation: request.generation,
      pid: worker.pid,
      env,
    }),
  );
  worker.kill = () => handle.kill();
  worker.wait = async () => {
    const result = await handle.wait();
    if (worker.status === 'spawning') {
      const text = `${result.stdout}\n${result.stderr}`;
      if (text.includes(marker)) {
        clearTimeout(timer);
        finishReady();
      } else {
        clearTimeout(timer);
        failSpawn('process exited before readiness marker');
      }
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return worker;
}
