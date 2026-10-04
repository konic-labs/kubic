// In-memory worker registry (issue #42): the host `workers` CLI reads
// live procs (age/owner/resources §50) from here — no filesystem, no
// network, clock injected so age is deterministic in tests.

import type { TaskResources } from '../../../agents/src/task.js';
import { StaleGenerationError } from './replace.js';
import type { AgentStatus, ProcessStatus } from './status.js';

export interface WorkerRegistration {
  workerId: string;
  sessionId: string;
  generation: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  /** §13 process phase; defaults to `spawning`. */
  status?: ProcessStatus;
  /** §13 agent state; defaults to `starting`. */
  agentStatus?: AgentStatus;
}

export interface WorkerRow {
  workerId: string;
  sessionId: string;
  generation: number;
  /** §13 PROCESS status (issue #151): spawning | ready | exiting. */
  status: ProcessStatus;
  /** §13 AGENT status (issue #151): starting | running | waiting | settling |
   *  completed | failed | cancelled | timeout | budget_exhausted |
   *  spawn_failed. */
  agentStatus: AgentStatus;
  startedAtMs: number;
  ageMs: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  startupMs?: number;
  /** The signal the worker process died from (issue #151), when it was
   *  signalled — the name behind the 128+n exit code. */
  signal?: string;
  /** §51 cancel outcome (issue #249): `settled` when the child's cooperative
   *  shutdown finished inside the worker grace, `forced` when the group
   *  SIGKILL escalation beat it. Absent when the worker was never cancelled. */
  cancel?: 'settled' | 'forced';
  /** The named failure the lifecycle settled this worker on (§82, issue #163):
   *  a resource breach names the limit that was hit, a crash its §52 code —
   *  so `kubic workers` says WHY the agent FAILED, not just that it did. */
  failure?: { code: string; message: string };
  /** The orchestrator process that owns this worker (crash recovery: a
   *  row whose manager is dead is reconciled, see orphans.ts). */
  managerPid?: number;
}

interface WorkerEntry {
  workerId: string;
  sessionId: string;
  generation: number;
  status: ProcessStatus;
  agentStatus: AgentStatus;
  startedAtMs: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  startupMs?: number;
  signal?: string;
  cancel?: 'settled' | 'forced';
  failure?: { code: string; message: string };
}

export class WorkerRegistry {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly clock: () => number;

  constructor(clock?: () => number) {
    this.clock = clock ?? Date.now;
  }

  register(registration: WorkerRegistration): WorkerRow {
    const entry: WorkerEntry = {
      workerId: registration.workerId,
      sessionId: registration.sessionId,
      generation: registration.generation,
      status: registration.status ?? 'spawning',
      agentStatus: registration.agentStatus ?? 'starting',
      startedAtMs: this.clock(),
      owner: registration.owner,
      resources: registration.resources,
      pid: registration.pid,
    };
    this.entries.set(registration.workerId, entry);
    return this.rowOf(entry);
  }

  replace(workerId: string, expectedGeneration?: number): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    // Compare-and-swap: a stale replacer names a generation that is no
    // longer live. Refuse without touching the row — no bump, no reset —
    // so the live worker survives the stale request.
    // Intended asymmetry with spawnWorker: the CAS uses strict `!==`,
    // refusing ANY mismatch — stale or future (a future expectation
    // means the caller holds a generation this registry never issued).
    // spawnWorker instead uses `<` and lets future generations through.
    // Arg order follows the StaleGenerationError (basis, candidate)
    // convention — live generation first, caller-presented expectation
    // second — so the refusal message reads unambiguously.
    if (
      expectedGeneration !== undefined &&
      entry.generation !== expectedGeneration
    ) {
      throw new StaleGenerationError(
        entry.sessionId,
        entry.generation,
        expectedGeneration,
      );
    }
    entry.generation += 1;
    entry.status = 'spawning';
    entry.agentStatus = 'starting';
    entry.startedAtMs = this.clock();
    entry.pid = undefined;
    entry.startupMs = undefined;
    entry.signal = undefined;
    entry.cancel = undefined;
    return this.rowOf(entry);
  }

  updateStatus(workerId: string, status: ProcessStatus): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.status = status;
    return this.rowOf(entry);
  }

  /** §13 agent state (issue #151), separate from the process phase. */
  updateAgentStatus(workerId: string, status: AgentStatus): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.agentStatus = status;
    return this.rowOf(entry);
  }

  /** §82 named failure (issue #163): recorded with the row where the agent
   *  settles FAILED on a known code. */
  recordFailure(
    workerId: string,
    failure: { code: string; message: string },
  ): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.failure = { code: failure.code, message: failure.message };
    return this.rowOf(entry);
  }

  /** §51 cancel outcome (issue #249): recorded with the row so an operator
   *  can tell a cooperative settle from a forced kill. */
  recordCancel(workerId: string, cancel: 'settled' | 'forced'): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.cancel = cancel;
    return this.rowOf(entry);
  }

  /** The signal the process died from (issue #151): recorded with the row so
   *  `kubic workers` names SIGKILL instead of an opaque 137. */
  recordSignal(workerId: string, signal: string | undefined): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.signal = signal;
    return this.rowOf(entry);
  }

  recordSpawn(
    workerId: string,
    pid: number | undefined,
    startupMs?: number,
  ): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.pid = pid;
    if (startupMs !== undefined) entry.startupMs = startupMs;
    return this.rowOf(entry);
  }

  get(workerId: string): WorkerRow | undefined {
    const entry = this.entries.get(workerId);
    return entry === undefined ? undefined : this.rowOf(entry);
  }

  list(): WorkerRow[] {
    return [...this.entries.values()].map((entry) => this.rowOf(entry));
  }

  remove(workerId: string): boolean {
    return this.entries.delete(workerId);
  }

  private rowOf(entry: WorkerEntry): WorkerRow {
    const now = this.clock();
    return {
      workerId: entry.workerId,
      sessionId: entry.sessionId,
      generation: entry.generation,
      status: entry.status,
      agentStatus: entry.agentStatus,
      startedAtMs: entry.startedAtMs,
      ageMs: now - entry.startedAtMs,
      owner: entry.owner,
      resources: entry.resources,
      pid: entry.pid,
      startupMs: entry.startupMs,
      signal: entry.signal,
      cancel: entry.cancel,
      failure: entry.failure,
    };
  }
}
