// Worker launch: the orchestrator's whole worker start path (issue #94;
// §13, §42, §50, §52, §61, §3.8).
//
// One call does what the live path used to skip: refuse a stale
// generation, register the worker and walk the §13 handshake
// (created → spawning → ready → running — through assertTransition, so an
// illegal jump throws instead of happening), spawn through the §3.8
// allowlist, wait for the readiness marker under a timeout, record the
// §61 startup latency, classify a failed child through the §52 failure
// codes, and reap through the teardown budget. `kubic workers` reads the
// rows this writes.
//
// The exec Shell seam has no env field, so the caller hands in a shell
// that can carry one (shell.ts `allowlistedShell` is the Node binding;
// the exec FakeExecutionEnv satisfies WorkerShell directly).

import type { Provenance } from '../../../exec/src/env.js';
import type { FailureCode } from '../lane/failures.js';
import { classifyFailure } from '../lane/failures.js';
import type { AgentResult, ResultErrorKind, ResultStatus } from '../result.js';
import { buildAgentResult, UNRESOLVED_MODEL } from '../result.js';
import type { KubicUsageRow, UsageSummary } from '../usage.js';
import { summarizeUsage } from '../usage.js';
import type { PerfGateResult, PerfSample } from './budgets.js';
import { checkPerfGate } from './budgets.js';
import type { ExitReport } from './reap.js';
import { reapDetached } from './reap.js';
import type { WorkerRegistry } from './registry.js';
import { StaleGenerationError } from './replace.js';
import type { SpawnWorkerRequest, WorkerShell } from './spawn.js';
import { spawnWorker } from './spawn.js';
import type { WorkerStatus } from './status.js';
import { assertTransition } from './status.js';

export interface LaunchWorkerRequest {
  workerId: string;
  sessionId: string;
  role: string;
  cmd: string;
  args: string[];
  /** Owner recorded on the registry row (§50: who started the worker). */
  owner?: string;
  /**
   * The generation the caller believes is live (resume reads it from the
   * stored run state). A mismatch is refused BEFORE any side effect — no
   * env build, no spawn, no generation bump — so a stale resume can never
   * spawn over a live worker.
   */
  expectedGeneration?: number;
  /**
   * The child's base environment. The launcher adds the worker's own
   * identity (KUBIC_WORKER_ID) on top; the §3.8 allowlist decides what of
   * the rest reaches the OS.
   */
  baseEnv: Record<string, string>;
  credentials?: Record<string, string>;
  provenance: Provenance;
  readyTimeoutMs?: number;
  /** Worktree/attach latencies the caller measured — the lifecycle layer
   *  times spawn, readiness and teardown itself. */
  worktreeMs?: number;
  attachMs?: number;
  /** §68 provenance (issue #185): the worktree the child runs in and the
   *  model/thinking it was pinned to, when the caller knows them. */
  worktree?: string;
  model?: string;
  thinking?: string;
}

export interface LaunchWorkerDeps {
  /** Shell seam that carries the filtered env (allowlistedShell, or a fake). */
  shell: WorkerShell;
  /** The one registry the orchestrator and `kubic workers` share. */
  registry: WorkerRegistry;
  clock?: () => number;
  debug?: (line: string) => void;
  /**
   * The child session's usage rows, read by the caller (the composition
   * root holds the session store; this layer never attaches a session).
   * Rolled up by `usage()` into the §39 readout. Omitted means the launch
   * reports an empty rollup rather than inventing one.
   */
  usageRows?: () => KubicUsageRow[];
}

export interface WorkerFailure {
  code: FailureCode;
  message: string;
  /** §52 error kind the code belongs to (result.ts ERROR_KINDS). */
  kind: ResultErrorKind;
}

export interface LaunchedWorker {
  workerId: string;
  sessionId: string;
  generation: number;
  pid: number | undefined;
  /** Redacted view of the child env (secrets never leave the seam). */
  env: Record<string, string>;
  /** Resolves when the readiness marker is seen; rejects with
   *  SpawnFailedError when it never arrives inside the timeout. */
  ready: Promise<void>;
  wait: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  status: () => WorkerStatus;
  /** §52 failure view of a launch/run that did not complete cleanly. */
  failure: () => WorkerFailure | undefined;
  /** The §68 worker result for this launch, built from what the child did:
   *  provenance always, error kind on failure, and the §61 sample as the
   *  wall-clock metric. Validated against the contract before it is
   *  handed back — a launch that cannot describe itself cannot be replayed. */
  result: () => AgentResult;
  /** §39 usage rollup of the child session (empty when the caller wired no
   *  usage reader — never a fabricated rollup). */
  usage: () => UsageSummary;
  /** Kill + drain, land the terminal §13 status, return the exit report. */
  reap: () => Promise<ExitReport>;
  /** The §61 sample with its budget verdict (startup/teardown measured here). */
  perf: () => PerfGateResult & { sample: PerfSample };
}

// The §78 exit code names the failure KIND; §52's classifier names the
// code within it. Nothing is guessed from the child's wording when the
// exit code already says what kind of failure this was.
const KIND_BY_EXIT: Record<number, ResultErrorKind> = {
  3: 'budget',
  4: 'approval',
  5: 'workspace',
  6: 'provider',
};

function exitFailure(exitCode: number, detail: string): WorkerFailure {
  const kind = KIND_BY_EXIT[exitCode] ?? 'process';
  const classified = classifyFailure(kind, `exited_${exitCode}`, detail);
  return {
    code: classified.code,
    kind,
    message: `worker exited ${exitCode}: ${detail.slice(0, 300)}`,
  };
}

export function launchWorker(
  request: LaunchWorkerRequest,
  deps: LaunchWorkerDeps,
): LaunchedWorker {
  const clock = deps.clock ?? Date.now;
  const registry = deps.registry;

  // Stale-generation guard FIRST: a resume that names a generation the
  // registry has already moved past is refused before anything happens.
  const existing = registry.get(request.workerId);
  if (
    request.expectedGeneration !== undefined &&
    existing !== undefined &&
    existing.generation !== request.expectedGeneration
  ) {
    throw new StaleGenerationError(
      request.sessionId,
      existing.generation,
      request.expectedGeneration,
    );
  }

  // Generation allocation + registration: a resumed run keeps its row and
  // bumps the generation, a fresh run registers at generation 1. Either
  // way the row exists BEFORE the child spawns, so `kubic workers` sees a
  // worker that is still booting.
  if (existing === undefined) {
    registry.register({
      workerId: request.workerId,
      sessionId: request.sessionId,
      generation: 1,
      owner: request.owner ?? 'orchestrator',
    });
  } else {
    registry.replace(request.workerId, existing.generation);
  }
  const generation = (registry.get(request.workerId) as { generation: number })
    .generation;
  let phase = assertTransition('created', 'spawning');
  registry.updateStatus(request.workerId, phase);

  const spawnStartedAt = clock();
  let spawnMs = 0;
  let pid: number | undefined;

  const spawnRequest: SpawnWorkerRequest = {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation,
    role: request.role,
    cmd: request.cmd,
    args: request.args,
    // The worker's own identity travels with the allowlist (§3.8): the
    // child prints its readiness marker under this id.
    baseEnv: { ...request.baseEnv, KUBIC_WORKER_ID: request.workerId },
    ...(request.credentials === undefined
      ? {}
      : { credentials: request.credentials }),
    provenance: request.provenance,
    ...(request.readyTimeoutMs === undefined
      ? {}
      : { readyTimeoutMs: request.readyTimeoutMs }),
  };

  const worker = spawnWorker(deps.shell, spawnRequest, {
    clock,
    getLiveGeneration: () => registry.get(request.workerId)?.generation,
    onDebug: deps.debug,
    onStartup: (startupMs) => {
      // The marker landed: the §13 handshake is complete (ready → running
      // is asserted, never skipped) and the §49.3 startup latency is
      // recorded on the row `kubic workers` reads.
      spawnMs = clock() - spawnStartedAt;
      phase = assertTransition('ready', 'running');
      registry.updateStatus(request.workerId, phase);
      registry.recordSpawn(request.workerId, pid, startupMs);
    },
  });
  pid = worker.pid;
  // The child process exists and is observable: spawning → ready. The
  // registry row now carries the real pid.
  phase = assertTransition(phase, 'ready');
  registry.updateStatus(request.workerId, phase);
  registry.recordSpawn(request.workerId, pid);

  let detail = '';
  let spawnFailureReason: string | undefined;
  let runFailure: WorkerFailure | undefined;

  const markSpawnFailed = (reason: string): void => {
    if (phase === 'spawn_failed') return;
    spawnFailureReason = reason;
    phase = 'spawn_failed';
    registry.updateStatus(request.workerId, phase);
  };

  const wait = async (): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> => {
    const done = await worker.wait();
    detail = done.stderr.trim() || done.stdout.trim();
    if (worker.status === 'spawn_failed') {
      markSpawnFailed('readiness marker not seen before the timeout');
      return done;
    }
    if (phase === 'ready' || phase === 'running') {
      const from = phase;
      phase = assertTransition(
        from,
        done.exitCode === 0 ? 'completed' : 'crashed',
      );
      registry.updateStatus(request.workerId, phase);
      if (phase === 'crashed') {
        runFailure = exitFailure(done.exitCode, detail);
      }
    }
    return done;
  };

  let teardownInitiateMs = 0;
  let teardownSettledMs = 0;
  let report: ExitReport | undefined;
  const reap = async (): Promise<ExitReport> => {
    if (report !== undefined) return report;
    const reapStartedAt = clock();
    const detached = reapDetached({
      workerId: request.workerId,
      kill: () => worker.kill(),
      wait: async () => {
        const done = await worker.wait();
        return { code: done.exitCode, signal: null };
      },
    });
    teardownInitiateMs = detached.teardownInitiateMs;
    report = await detached.reaped;
    teardownSettledMs = clock() - reapStartedAt;
    if (phase !== 'spawn_failed' && phase !== 'completed') {
      phase = assertTransition(
        phase,
        report.kind === 'completed' ? 'completed' : 'crashed',
      );
      registry.updateStatus(request.workerId, phase);
      if (phase === 'crashed' && runFailure === undefined) {
        runFailure = exitFailure(report.code ?? 1, detail);
      }
    }
    return report;
  };

  const sample = (): PerfSample => ({
    // spawnMs is the measured start-to-marker span; an unfinished launch
    // leaves it 0 rather than reporting a budget pass on a phase that has
    // not happened yet.
    spawnMs,
    startupMs: worker.startupMs,
    ...(request.attachMs === undefined ? {} : { attachMs: request.attachMs }),
    ...(request.worktreeMs === undefined
      ? {}
      : { worktreeMs: request.worktreeMs }),
    teardownInitiateMs,
    teardownSettledMs,
  });

  // §68: the one worker → host payload. Status maps from the §13 phase
  // (the lifecycle owns the vocabulary; §68 owns the result literal), the
  // §52 failure carries its kind through, and metrics carry the §61
  // sample — a worker that reports no latency cannot be budgeted.
  const result = (): AgentResult => {
    const failure =
      spawnFailureReason === undefined
        ? runFailure
        : {
            code: 'process_spawn_failed' as const,
            kind: 'process' as const,
            message: `spawn failed for worker ${request.workerId}: ${spawnFailureReason}`,
          };
    // §13 phase → §68 result status: the lifecycle owns the phase
    // vocabulary, the result contract owns its literals, and the mapping
    // between them is total (spawn_failed and completed map directly; a
    // crashed/never-ready worker is a failure).
    const status: ResultStatus =
      phase === 'spawn_failed'
        ? 'spawn_failed'
        : phase === 'completed'
          ? 'completed'
          : 'failed';
    // The one §68 builder (issue #185) zero-fills the token metrics the
    // lifecycle cannot see and self-checks against the closed-world
    // contract: a result that fails its own validator is a bug here.
    return buildAgentResult({
      status,
      summary:
        failure === undefined
          ? `worker ${request.workerId} ${phase}`
          : failure.message,
      provenance: {
        workerId: request.workerId,
        sessionId: request.sessionId,
        pid: pid ?? null,
        generation,
        worktree:
          request.worktree ?? `(unrecorded worktree of ${request.workerId})`,
        model: request.model ?? UNRESOLVED_MODEL,
        role: request.role,
        ...(request.thinking === undefined
          ? {}
          : { thinking: request.thinking }),
      },
      metrics: {
        latencyMs: worker.startupMs ?? 0,
        wallMs: Math.max(0, clock() - spawnStartedAt),
      },
      ...(failure === undefined
        ? {}
        : {
            error: {
              kind: failure.kind,
              message: failure.message,
              details: { code: failure.code },
            },
          }),
    });
  };

  // A readiness timeout or an exit before the marker is terminal in the
  // registry even for a caller that only watches `failure()`; the marker
  // rejection is observed here so it is never an unhandled rejection.
  void worker.ready.catch(() => {
    if (phase !== 'spawn_failed') {
      markSpawnFailed('readiness marker not seen before the timeout');
    }
  });

  return {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation,
    pid,
    env: worker.env,
    ready: worker.ready,
    wait,
    status: () => phase,
    failure: () =>
      spawnFailureReason === undefined
        ? runFailure
        : {
            code: 'process_spawn_failed',
            kind: 'process',
            message: `spawn failed for worker ${request.workerId}: ${spawnFailureReason}`,
          },
    result,
    usage: () => summarizeUsage(deps.usageRows?.() ?? []),
    reap,
    perf: () => {
      const perfSample = sample();
      return { ...checkPerfGate(perfSample), sample: perfSample };
    },
  };
}
