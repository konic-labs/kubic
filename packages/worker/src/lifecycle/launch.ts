// Worker launch: the orchestrator's whole worker start path (issue #94;
// §13, §42, §50, §52, §61, §3.8).
//
// One call does what the live path used to skip: refuse a stale
// generation, register the worker and walk the §13 handshake (the PROCESS
// goes spawning → ready → exiting; the AGENT goes starting → running →
// waiting/settling → a §13 terminal — each transition guarded, so an illegal
// jump throws instead of happening), spawn through the §3.8 allowlist, wait
// for the readiness marker under a timeout, record the §61 startup latency,
// classify a failed child through the §52 failure codes, and reap through the
// teardown budget. `kubic workers` reads the rows this writes.

// §51 cancellation grace (issue #249): a worker is not a tool call. Its
// SIGTERM handler runs a durable abort, a kill-registry drain and a reconcile
// sweep, which the 2 s KILL_GRACE_MS cuts off mid-flight; the worker grace is
// the longer bound, and a cancel that still had to escalate is recorded as
// `forced` on the row.
export const DEFAULT_WORKER_CANCEL_GRACE_MS = 10_000;

// §13 (issue #151): the launcher owns BOTH vocabularies. The process phase is
// the child's own state (spawning → ready → exiting); the agent state is what
// the delegated work did. An exit settles the agent only as far as the exit
// itself proves: a clean exit is SETTLING, and the run path settles it as
// COMPLETED or FAILED once the §68 report has been checked.
//
// The exec Shell seam has no env field, so the caller hands in a shell
// that can carry one (shell.ts `allowlistedShell` is the Node binding;
// the exec FakeExecutionEnv satisfies WorkerShell directly).

import type { TaskResources } from '../../../agents/src/task.js';
import type { Provenance } from '../../../exec/src/env.js';
import type { FailureCode } from '../lane/failures.js';
import { classifyFailure } from '../lane/failures.js';
import type { AgentResult, ResultErrorKind, ResultStatus } from '../result.js';
import { buildAgentResult, UNRESOLVED_MODEL } from '../result.js';

import type { PerfGateResult, PerfSample } from './budgets.js';
import { checkPerfGate } from './budgets.js';
import type { ExitReport } from './reap.js';
import { reapDetached, TEARDOWN_BUDGET_MS } from './reap.js';
import type { WorkerRegistry } from './registry.js';
import type {
  ResourceBreach,
  ResourceKind,
  ResourceLimits,
  ResourceProbes,
  ResourceWatchdog,
} from './resources.js';
import {
  createResourceWatchdog,
  type RESOURCE_LIMIT_CODES,
} from './resources.js';

/** The named §82 codes a breached limit settles on. */
export type ResourceLimitCode = (typeof RESOURCE_LIMIT_CODES)[ResourceKind];

import { StaleGenerationError } from './replace.js';
import type { SpawnWorkerRequest, WorkerShell } from './spawn.js';
import { spawnWorker } from './spawn.js';
import type { AgentStatus, ProcessStatus } from './status.js';
import {
  AgentTransitionError,
  assertAgentTransition,
  assertProcessTransition,
  classifyExit,
} from './status.js';

export interface LaunchWorkerRequest {
  workerId: string;
  sessionId: string;
  role: string;
  /**
   * The role whose grant namespace the credentials are minted under
   * (issue #200). The child reads back the role it was TOLD it runs as;
   * a resolver without a role document is told nothing and falls back to
   * `worker`, while its row keeps the spec's role. Defaults to `role`.
   */
  grantRole?: string;
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
  /**
   * §82 per-agent limits (issue #163): the RSS cap (MB) the manager samples
   * and the worktree disk quota (MB) it checks. A limit without its probe is
   * not enforced (`enforcedLimits`); absent means no runtime limit.
   */
  memoryLimitMb?: number;
  diskQuotaMb?: number;
  /**
   * §51 cancellation grace (issue #249): how long the worker's own
   * cooperative shutdown gets after SIGTERM before the group SIGKILL
   * escalation. The worker's settle (durable abort, kill-registry drain,
   * reconcile sweep) is not a tool call, so it is NOT bounded by the 2 s
   * tool grace; absent uses DEFAULT_WORKER_CANCEL_GRACE_MS.
   */
  cancelGraceMs?: number;
  /** Worktree/attach latencies the caller measured — the lifecycle layer
   *  times spawn, readiness and teardown itself. */
  worktreeMs?: number;
  attachMs?: number;
  /** §68 provenance (issue #185): the worktree the child runs in and the
   *  model/thinking it was pinned to, when the caller knows them. */
  worktree?: string;
  model?: string;
  thinking?: string;
  /**
   * §67 task resources this spawn was granted (issue #170): recorded on the
   * registry row, which is what `kubic workers` prints (`skills=…`). Absent
   * means no resources were configured for the spawn.
   */
  resources?: TaskResources;
}

export interface LaunchWorkerDeps {
  /** Shell seam that carries the filtered env (allowlistedShell, or a fake). */
  shell: WorkerShell;
  /** The one registry the orchestrator and `kubic workers` share. */
  registry: WorkerRegistry;
  clock?: () => number;
  debug?: (line: string) => void;
  /**
   * §82 resource probes (issue #163): RSS of the worker's process group and
   * the worktree's size. The composition root supplies them (this layer never
   * reads /proc or runs `du`); absent means the corresponding limit cannot be
   * enforced, and `enforcedLimits` reports that.
   */
  resourceProbes?: ResourceProbes;
  /** Resource poll cadence; the default is one second. */
  resourcePollMs?: number;
}

export interface WorkerFailure {
  // §82 resource codes (issue #163) are lifecycle-owned: they are not part of
  // the §52 lane taxonomy, but a worker stopped by a breached limit names
  // which one on the same failure view.
  code: FailureCode | ResourceLimitCode;
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
  wait: () => Promise<{
    exitCode: number;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>;
  /** §13 process phase (issue #151): spawning | ready | exiting. */
  processStatus: () => ProcessStatus;
  /** §13 agent state (issue #151): what the delegated work did. */
  agentStatus: () => AgentStatus;
  /** §68 settling (issue #151): the run path decides COMPLETED or FAILED
   *  once the worker's report has been validated. Only a SETTLING agent can
   *  be settled; anything else throws. */
  settleAgent: (status: 'completed' | 'failed') => AgentStatus;
  /** §13 terminus correction (issue #151): the child's own report can name a
   *  terminus the exit code cannot — a `--timeout` run exits 1 with report
   *  status `timeout` (issue #280). Only the run path, which read the report,
   *  calls this, and only a named terminus may replace the unclassified
   *  FAILED an exit 1 produced; anything else throws. */
  settleFromReport: (
    status: 'timeout' | 'cancelled' | 'budget_exhausted',
  ) => AgentStatus;
  /** §52 failure view of a launch/run that did not complete cleanly. */
  failure: () => WorkerFailure | undefined;
  /** §82 resource watchdog (issue #163), when a probe was wired: `poll()`
   *  runs one sample deterministically, `stop()` ends the interval. */
  resources: () => ResourceWatchdog | undefined;
  /** The §68 worker result for this launch, built from what the child did:
   *  provenance always, error kind on failure, and the §61 sample as the
   *  wall-clock metric. Validated against the contract before it is
   *  handed back — a launch that cannot describe itself cannot be replayed. */
  result: () => AgentResult;
  /** Kill + drain, land the terminal §13 status, return the exit report.
   *  `reason` names the manager's terminus (issue #151/#163): `cancel`
   *  (default), `timeout`, `budget` or `resource` — a live worker settles on
   *  that state, not on a generic crash. */
  reap: (
    reason?: 'cancel' | 'timeout' | 'budget' | 'resource',
  ) => Promise<ExitReport>;
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
      ...(request.resources === undefined
        ? {}
        : { resources: request.resources }),
    });
  } else {
    registry.replace(request.workerId, existing.generation);
  }
  const generation = (registry.get(request.workerId) as { generation: number })
    .generation;
  let process: ProcessStatus = 'spawning';
  let agent: AgentStatus = 'starting';
  let signal: string | undefined;
  // A reap in flight (issue #151): the child's exit is the manager's
  // cancellation, not a crash, however the signal arrives.
  let cancelRequested = false;
  registry.updateStatus(request.workerId, process);
  registry.updateAgentStatus(request.workerId, agent);

  const spawnStartedAt = clock();
  let spawnMs = 0;
  let pid: number | undefined;

  const spawnRequest: SpawnWorkerRequest = {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation,
    role: request.role,
    ...(request.grantRole === undefined
      ? {}
      : { grantRole: request.grantRole }),
    cmd: request.cmd,
    args: request.args,
    // The worker's own identity travels with the allowlist (§3.8): the
    // child prints its readiness marker under this id, and records this
    // generation — the one its `kubic workers` row carries — in the §46
    // trajectory it writes (issue #383).
    baseEnv: {
      ...request.baseEnv,
      KUBIC_WORKER_ID: request.workerId,
      KUBIC_WORKER_GENERATION: String(generation),
    },
    ...(request.credentials === undefined
      ? {}
      : { credentials: request.credentials }),
    provenance: request.provenance,
    ...(request.readyTimeoutMs === undefined
      ? {}
      : { readyTimeoutMs: request.readyTimeoutMs }),
    killGraceMs: request.cancelGraceMs ?? DEFAULT_WORKER_CANCEL_GRACE_MS,
  };

  const worker = spawnWorker(deps.shell, spawnRequest, {
    clock,
    getLiveGeneration: () => registry.get(request.workerId)?.generation,
    onDebug: deps.debug,
    onStartup: (startupMs) => {
      // The marker landed: the §13 handshake is complete (starting →
      // running is asserted, never skipped) and the §49.3 startup latency is
      // recorded on the row `kubic workers` reads.
      spawnMs = clock() - spawnStartedAt;
      agent = assertAgentTransition(agent, 'running');
      registry.updateAgentStatus(request.workerId, agent);
      registry.recordSpawn(request.workerId, pid, startupMs);
    },
  });
  pid = worker.pid;
  // The child process exists and is observable: spawning → ready. The
  // registry row now carries the real pid.
  process = assertProcessTransition(process, 'ready');
  registry.updateStatus(request.workerId, process);
  registry.recordSpawn(request.workerId, pid);

  let detail = '';
  let spawnFailureReason: string | undefined;
  let runFailure: WorkerFailure | undefined;
  // §82 (issue #163): the named breach that stopped this worker, if any.
  let resourceFailure: WorkerFailure | undefined;

  const markSpawnFailed = (reason: string): void => {
    if (agent === 'spawn_failed') return;
    spawnFailureReason = reason;
    if (process !== 'exiting') {
      process = assertProcessTransition(process, 'exiting');
      registry.updateStatus(request.workerId, process);
    }
    agent = assertAgentTransition(agent, 'spawn_failed');
    registry.updateAgentStatus(request.workerId, agent);
  };

  const wait = async (): Promise<{
    exitCode: number;
    signal: string | null;
    stdout: string;
    stderr: string;
  }> => {
    const done = await worker.wait();
    detail = done.stderr.trim() || done.stdout.trim();
    if (worker.unready) {
      markSpawnFailed('readiness marker not seen before the timeout');
      return done;
    }
    if (process === 'ready') {
      settleFromExit(done.exitCode, done.signal, cancelRequested);
    }
    return done;
  };

  // The exit's own verdict (issue #151): the process is gone and the agent
  // takes the §13 state the exit proves. A clean exit is SETTLING — never
  // COMPLETED, which only the §68 report check can decide (the run path calls
  // `settleAgent`). `cancelled` is the manager's own kill.
  const settleFromExit = (
    exitCode: number,
    exitSignal: string | null,
    cancelled: boolean,
  ): void => {
    if (process !== 'exiting') {
      process = assertProcessTransition(process, 'exiting');
      registry.updateStatus(request.workerId, process);
    }
    const classified = classifyExit({
      code: exitCode,
      signal: exitSignal,
      cancelled,
      declaredExit: exitCode,
    });
    signal = exitSignal ?? undefined;
    if (agent !== classified.agent) {
      agent = assertAgentTransition(agent, classified.agent);
      registry.updateAgentStatus(request.workerId, agent);
      registry.recordSignal(request.workerId, signal);
    }
    if (classified.kind !== 'completed' && runFailure === undefined) {
      runFailure = exitFailure(exitCode, detail);
    }
    // §82 (issue #163): the row names the code the agent FAILED on, so
    // `kubic workers` reads WHY, not just that it did.
    if (agent === 'failed' && runFailure !== undefined) {
      registry.recordFailure(request.workerId, {
        code: runFailure.code,
        message: runFailure.message,
      });
    }
  };

  // §13 settling (issue #151): the run path settles the agent once the §68
  // report has been validated — COMPLETED when it parses, FAILED when it does
  // not. Only a SETTLING agent can be settled, so a second call is refused
  // (an illegal transition throws, never silently re-settles).
  const settleAgent = (status: 'completed' | 'failed'): AgentStatus => {
    agent = assertAgentTransition(agent, status);
    registry.updateAgentStatus(request.workerId, agent);
    return agent;
  };

  const settleFromReport = (
    status: 'timeout' | 'cancelled' | 'budget_exhausted',
  ): AgentStatus => {
    if (agent === status) return agent;
    if (agent === 'settling' || agent === 'failed') {
      agent = status;
    } else {
      throw new AgentTransitionError(agent, status);
    }
    registry.updateAgentStatus(request.workerId, agent);
    return agent;
  };

  let teardownInitiateMs = 0;
  let teardownSettledMs = 0;
  let report: ExitReport | undefined;
  const reap = async (
    reason: 'cancel' | 'timeout' | 'budget' | 'resource' = 'cancel',
  ): Promise<ExitReport> => {
    if (report !== undefined) return report;
    // §51 (issue #151): a reap of a STILL-LIVE worker is the manager's
    // cancellation; a reap of one that already exited on its own keeps the
    // exit's own verdict (a settling agent is settled by the run path).
    const cancelling =
      agent === 'starting' || agent === 'running' || agent === 'waiting';
    if (cancelling && reason === 'cancel') cancelRequested = true;
    const reapStartedAt = clock();
    const detached = reapDetached(
      {
        workerId: request.workerId,
        kill: () => worker.kill(),
        wait: async () => {
          const done = await worker.wait();
          return {
            code: done.exitCode,
            signal: done.signal,
            forced: done.forced,
          };
        },
        // The manager's own kill (issue #151): §51 cancel terminates its
        // worker, so the agent settles CANCELLED, never CRASHED.
        cancelled: cancelling,
      },
      {
        // The manager waits for the child's WHOLE cooperative drain, not just
        // the kill (issue #249): the abort may take up to the grace, and the
        // exec seam then reaps the process group for up to the grace again —
        // abort <= grace, then reapGroup's SIGTERM wait <= grace. (reapGroup
        // runs a SECOND bounded wait after SIGKILL, but that one only elapses
        // for a group that survives SIGKILL, which is not a cooperative case:
        // there `forced` is the honest verdict.) So the budget is twice the
        // grace plus the teardown budget. A shorter wait would report a
        // timeout — `cancel: "forced"` — for a worker that was still settling
        // inside the grace it was given.
        settleTimeoutMs:
          2 * (request.cancelGraceMs ?? DEFAULT_WORKER_CANCEL_GRACE_MS) +
          TEARDOWN_BUDGET_MS,
      },
    );
    teardownInitiateMs = detached.teardownInitiateMs;
    report = await detached.reaped;
    teardownSettledMs = clock() - reapStartedAt;
    resourceWatchdog?.stop();
    // A launch that never became ready and a worker the run already settled
    // keep their verdict; anything else is the cancellation this call made.
    // §51 cancel outcome (issue #249): the row says whether the child's own
    // shutdown settled inside the worker grace or the SIGKILL forced it.
    // Only a worker that was actually cancelled carries the field — a reap
    // after the child exited on its own is teardown, not a cancellation.
    if (cancelRequested) {
      registry.recordCancel(
        request.workerId,
        report.forced === true ? 'forced' : 'settled',
      );
    }
    if (reason === 'resource' && agent !== 'spawn_failed') {
      // §82 (issue #163): the manager stopped the worker because a limit was
      // breached — the agent FAILED on the named resource code, never
      // CANCELLED (nobody asked it to stop). The resource verdict WINS over
      // the exit the kill produced (the wait may have settled first, calling
      // the signal death a generic crash).
      if (resourceFailure !== undefined) runFailure = resourceFailure;
      if (agent !== 'failed') {
        agent = 'failed';
        registry.updateAgentStatus(request.workerId, agent);
      }
      if (runFailure !== undefined) {
        registry.recordFailure(request.workerId, {
          code: runFailure.code,
          message: runFailure.message,
        });
      }
    } else if (cancelling && agent !== 'spawn_failed') {
      if (agent === 'failed' || agent === 'settling') {
        // The wait already settled the exit (a signal death is an
        // unclassified FAILED); the manager's kill is the terminus that wins
        // — §51 cancel terminates its worker, so the agent is CANCELLED.
        settleFromReport('cancelled');
      } else {
        settleFromExit(report.code ?? 1, report.signal, true);
      }
    }
    return report;
  };

  // §82 runtime enforcement (issue #163): sample the worker's RSS and its
  // worktree on an interval. A breach stops the worker through the same reap
  // path a cancel uses, with the named resource code carried into the failure
  // (and so into the §68 result, the row and the run's terminus).
  const limits: ResourceLimits = {
    ...(request.memoryLimitMb === undefined
      ? {}
      : { memMb: request.memoryLimitMb }),
    ...(request.diskQuotaMb === undefined
      ? {}
      : { diskMb: request.diskQuotaMb }),
  };
  const resourceWatchdog =
    deps.resourceProbes === undefined
      ? undefined
      : createResourceWatchdog({
          limits,
          probes: deps.resourceProbes,
          ...(deps.resourcePollMs === undefined
            ? {}
            : { pollMs: deps.resourcePollMs }),
          pid: () => pid,
          worktree:
            request.worktree ?? `(unrecorded worktree of ${request.workerId})`,
          onBreach: (breach: ResourceBreach) => {
            resourceFailure = {
              code: breach.code,
              kind: 'process',
              message: breach.message,
            };
            // Recorded BEFORE the kill: the run reads `failure()` as soon as
            // the child settles, and the wait may settle before the reap's own
            // branch runs — the breach is the manager's verdict either way.
            runFailure = resourceFailure;
            deps.debug?.(
              `resource: worker '${request.workerId}' — ${breach.message}`,
            );
            void reap('resource').catch(() => undefined);
          },
        });

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
      agent === 'spawn_failed'
        ? 'spawn_failed'
        : agent === 'completed'
          ? 'completed'
          : agent === 'cancelled'
            ? 'cancelled'
            : agent === 'timeout'
              ? 'timeout'
              : agent === 'budget_exhausted'
                ? 'budget_exhausted'
                : 'failed';
    // The one §68 builder (issue #185) zero-fills the token metrics the
    // lifecycle cannot see and self-checks against the closed-world
    // contract: a result that fails its own validator is a bug here.
    return buildAgentResult({
      status,
      summary:
        failure === undefined
          ? `worker ${request.workerId} ${agent}`
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
    if (agent !== 'spawn_failed') {
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
    processStatus: () => process,
    agentStatus: () => agent,
    settleAgent,
    settleFromReport,
    failure: () =>
      spawnFailureReason === undefined
        ? runFailure
        : {
            code: 'process_spawn_failed',
            kind: 'process',
            message: `spawn failed for worker ${request.workerId}: ${spawnFailureReason}`,
          },
    resources: () => resourceWatchdog,
    result,
    reap,
    perf: () => {
      const perfSample = sample();
      return { ...checkPerfGate(perfSample), sample: perfSample };
    },
  };
}
