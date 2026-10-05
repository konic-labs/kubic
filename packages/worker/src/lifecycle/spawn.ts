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
import type { ProcessStatus } from './status.js';

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
  /**
   * The role whose grant namespace the credentials are minted under. A
   * child reads back exactly the role it was TOLD it runs as (issue #200),
   * which is not always the role recorded on the launch row (a resolver
   * child without a role document runs the default tool set). Defaults to
   * `role` — the two agree on every other path.
   */
  grantRole?: string;
  cmd: string;
  args: string[];
  baseEnv: Record<string, string>;
  credentials?: Record<string, string>;
  provenance: Provenance;
  readyTimeoutMs?: number;
  /**
   * §51 cancellation grace (issue #249): how long the child's own cooperative
   * shutdown gets after SIGTERM before the group SIGKILL escalation. The
   * worker's settle (durable abort, kill-registry drain, reconcile sweep)
   * needs more than the 2 s tool bound, so the caller passes a worker grace;
   * absent keeps the exec default.
   */
  killGraceMs?: number;
}

export interface SpawnWorkerDeps {
  clock?: () => number;
  onStartup?: (startupMs: number) => void;
  // Live generation for request.sessionId, when the caller tracks one
  // (e.g. the WorkerRegistry row). A request naming an older generation
  // is stale and refused before any side effect.
  // REQUIRED wiring at the composition root for any orchestrator that
  // spawns into a session with live generations: callers that leave
  // this unwired get NO stale-generation check — spawn proceeds
  // unconditionally.
  // Intended asymmetry with WorkerRegistry.replace: this check uses
  // `<`, so a request naming a FUTURE generation still spawns (the
  // allocator may have bumped past our snapshot); the registry CAS
  // uses strict `!==` and refuses any mismatch, stale or future. Only
  // a strictly older generation is stale here.
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
  /** §13 process phase: spawning | ready | exiting (issue #151). */
  status: ProcessStatus;
  /** True when the process ended before the readiness handshake — the
   *  spawn layer's own marker, so the launch layer can settle the agent as
   *  SPAWN_FAILED without guessing from an exit code. */
  unready: boolean;
  // Redacted-for-log view of the child env (redactEnvForLog): keys stay
  // for debugging, secret values never do. The plaintext env reaches only
  // the exec Shell seam in spawn options — never this handle.
  env: Record<string, string>;
  startedAtMs: number;
  startupMs: number | undefined;
  ready: Promise<void>;
  wait: () => Promise<{
    exitCode: number;
    signal: string | null;
    /** The SIGKILL escalation beat the child's cooperative shutdown
     *  (issue #249): the cancel was FORCED, not settled. */
    forced: boolean;
    stdout: string;
    stderr: string;
  }>;
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
  // before any side effect (no env build, no shell spawn). Future
  // generations pass: see the getLiveGeneration asymmetry note above.
  const live = deps?.getLiveGeneration?.(request.sessionId);
  if (live !== undefined && request.generation < live) {
    throw new StaleGenerationError(request.sessionId, live, request.generation);
  }
  const clock = deps?.clock ?? Date.now;
  const startedAtMs = clock();
  const env = buildSpawnEnv(
    request.baseEnv,
    request.grantRole ?? request.role,
    request.credentials ?? {},
  );
  const marker = readyMarker(request.workerId);
  const worker: SpawnedWorker = {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation: request.generation,
    pid: undefined,
    status: 'spawning',
    unready: false,
    env: redactEnvForLog(env),
    startedAtMs,
    startupMs: undefined,
    ready: Promise.resolve(),
    wait: () =>
      Promise.resolve({
        exitCode: 0,
        signal: null,
        forced: false,
        stdout: '',
        stderr: '',
      }),
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
    worker.status = 'ready';
    deps?.onStartup?.(worker.startupMs);
    settleReady();
  };

  const failSpawn = (reason: string): void => {
    if (worker.status !== 'spawning') return;
    worker.status = 'exiting';
    worker.unready = true;
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

  // Readiness scans only the NEW tail of each stream (issue #187): the
  // shell delivers cumulative snapshots, so re-scanning the whole buffer on
  // every chunk is quadratic over a chatty boot. Each stream keeps its own
  // scanned length plus a marker-sized carry, so a marker split across two
  // chunks — or across a trimmed accumulator tail, which reads as a
  // shorter snapshot — is still detected. Past 'spawning' nothing is
  // touched at all: the snapshot text is never even read.
  let seenOut = 0;
  let seenIn = 0;
  let carryOut = '';
  let carryIn = '';
  // Undefined means the marker was found; otherwise the carry for the
  // next chunk (at most marker.length - 1 chars — any marker overlapping
  // the new tail starts inside it).
  const scanTail = (tail: string, carry: string): string | undefined => {
    const text = carry + tail;
    if (text.includes(marker)) return undefined;
    return text.slice(-(marker.length - 1));
  };
  let handle: ProcessHandle;
  try {
    handle = shell.spawn(request.cmd, request.args, {
      provenance: request.provenance,
      env,
      ...(request.killGraceMs === undefined
        ? {}
        : { killGraceMs: request.killGraceMs }),
      onUpdate: (snapshot) => {
        if (worker.status !== 'spawning') return;
        // A trimmed accumulator tail reads shorter than what was scanned:
        // rescan it whole (bounded by the stream cap) rather than slicing
        // past the new start.
        if (snapshot.stdout.length < seenOut) seenOut = 0;
        if (snapshot.stderr.length < seenIn) seenIn = 0;
        const tailOut = snapshot.stdout.slice(seenOut);
        const tailIn = snapshot.stderr.slice(seenIn);
        seenOut = snapshot.stdout.length;
        seenIn = snapshot.stderr.length;
        // A readiness marker never spans the two streams (they are
        // different pipes), so each is scanned with its own carry.
        const nextOut = scanTail(tailOut, carryOut);
        if (nextOut === undefined) {
          clearTimeout(timer);
          finishReady();
          return;
        }
        carryOut = nextOut;
        const nextIn = scanTail(tailIn, carryIn);
        if (nextIn === undefined) {
          clearTimeout(timer);
          finishReady();
          return;
        }
        carryIn = nextIn;
      },
    });
  } catch (error) {
    clearTimeout(timer);
    worker.status = 'exiting';
    worker.unready = true;
    failReady(
      error instanceof Error
        ? error
        : new SpawnFailedError(request.workerId, String(error)),
    );
    worker.wait = () =>
      worker.ready.then(() => ({
        exitCode: 1,
        signal: null,
        forced: false,
        stdout: '',
        stderr: '',
      }));
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
      signal: result.signal ?? null,
      forced: result.forced === true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return worker;
}
