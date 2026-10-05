// Worker replace (issue #42; §11, §20.3): crash → terminate the old
// proc, bump the generation, SessionRepo.open the session, lane.resume
// the lane. Memos (§20.3) travel outside the dead proc — the
// replacement drains the same deferred answers through memoOnce, so a
// kill during a deferred approval never repeats the approved effect.
// SessionRepo and lane types stay structural: this module reads their
// shapes (open, resume) without owning them.

export interface ReplaceRequest {
  workerId: string;
  sessionId: string;
  oldGeneration: number;
}

export interface ReplaceLane {
  laneId: string;
}

export interface ReplaceDeps {
  allocateGeneration: (sessionId: string) => number;
  openSession: (sessionId: string) => Promise<ReplaceLane>;
  resumeLane: (lane: ReplaceLane) => Promise<{ resumed: boolean }>;
  terminate: (workerId: string) => Promise<void>;
}

export interface ReplaceOutcome {
  workerId: string;
  sessionId: string;
  generation: number;
  resumed: boolean;
}

export class StaleGenerationError extends Error {
  // Arg convention (basis, candidate): oldGeneration is the basis the
  // request is measured against (the live generation, or the claimed
  // old generation); next is the candidate generation the caller
  // presented (or was allocated). The message names both roles
  // explicitly so expected-vs-live order reads unambiguously at every
  // throw site (spawn, replace, registry CAS).
  constructor(sessionId: string, oldGeneration: number, next: number) {
    super(
      `stale generation for session ${sessionId}: got generation ${next}, want newer than ${oldGeneration}`,
    );
    this.name = 'StaleGenerationError';
  }
}

export async function replaceWorker(
  request: ReplaceRequest,
  deps: ReplaceDeps,
): Promise<ReplaceOutcome> {
  // The expected generation is validated BEFORE terminate: a stale
  // request must never kill the live worker and then throw.
  const generation = deps.allocateGeneration(request.sessionId);
  if (generation <= request.oldGeneration) {
    throw new StaleGenerationError(
      request.sessionId,
      request.oldGeneration,
      generation,
    );
  }
  await deps.terminate(request.workerId);
  const lane = await deps.openSession(request.sessionId);
  const resumed = await deps.resumeLane(lane);
  // Issue #153: memo survival rides pi-durable's committed task record
  // (api.memo scoped to the invocation), not a Kubic outcome flag — so a
  // replaced worker carries no memos field at all.
  return {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation,
    resumed: resumed.resumed,
  };
}
