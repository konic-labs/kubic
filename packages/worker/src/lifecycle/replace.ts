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
  memosSurvived: boolean;
}

export class StaleGenerationError extends Error {
  constructor(sessionId: string, oldGeneration: number, next: number) {
    super(
      `refusing replace for session ${sessionId}: generation ${next} is not newer than ${oldGeneration}`,
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
  return {
    workerId: request.workerId,
    sessionId: request.sessionId,
    generation,
    resumed: resumed.resumed,
    // Memos live outside the dead proc (MemoryMemoStore travels with the
    // session scope, never inside the reaped process) — by the time the
    // lane resumes, memoOnce answers are already in place.
    memosSurvived: true,
  };
}
