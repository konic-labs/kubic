// In-memory worker registry (issue #42): the host `workers` CLI reads
// live procs (age/owner/resources §50) from here — no filesystem, no
// network, clock injected so age is deterministic in tests.

import type { TaskResources } from '../../../agents/src/task.js';
import { StaleGenerationError } from './replace.js';
import type { WorkerStatus } from './status.js';

export interface WorkerRegistration {
  workerId: string;
  sessionId: string;
  generation: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  status?: WorkerStatus;
}

export interface WorkerRow {
  workerId: string;
  sessionId: string;
  generation: number;
  status: WorkerStatus;
  startedAtMs: number;
  ageMs: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  startupMs?: number;
}

interface WorkerEntry {
  workerId: string;
  sessionId: string;
  generation: number;
  status: WorkerStatus;
  startedAtMs: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  startupMs?: number;
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
      status: registration.status ?? 'created',
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
    entry.status = 'created';
    entry.startedAtMs = this.clock();
    entry.pid = undefined;
    entry.startupMs = undefined;
    return this.rowOf(entry);
  }

  updateStatus(workerId: string, status: WorkerStatus): WorkerRow {
    const entry = this.entries.get(workerId);
    if (entry === undefined) {
      throw new Error(`unknown worker: ${workerId}`);
    }
    entry.status = status;
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
      startedAtMs: entry.startedAtMs,
      ageMs: now - entry.startedAtMs,
      owner: entry.owner,
      resources: entry.resources,
      pid: entry.pid,
      startupMs: entry.startupMs,
    };
  }
}
