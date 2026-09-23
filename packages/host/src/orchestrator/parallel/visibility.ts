// Parallel visibility hooks (issue #47; §49.1, §50).
// Pure presenters: the scheduler hands plain numbers to these builders and
// the tree/workers/trajectory surfaces render them. No imports from the
// CLI surfaces (no main.ts wiring here) — the composition root calls these.

export interface ParallelConc {
  running: number;
  queued: number;
  maxConcurrency: number;
}

export interface ParallelSnapshot extends ParallelConc {
  sessionId: string;
}

export interface ParallelUsage {
  requests: number;
  costTotal: number;
  tokens: number;
}

export interface ParallelWorkersExtra {
  running: number;
  queued: number;
  maxConcurrency: number;
  usage?: ParallelUsage;
}

export interface ParallelTrajectoryEvent {
  kind: 'parallel';
  sessionId: string;
  running: number;
  queued: number;
  maxConcurrency: number;
  wakeups: string[];
  usage?: ParallelUsage;
}

// One-line `tree` fragment: `sess-1 parallel 3/4 (queued 1)`.
export function buildParallelTreeLine(snapshot: ParallelSnapshot): string {
  const base = `${snapshot.sessionId} parallel ${snapshot.running}/${snapshot.maxConcurrency}`;
  if (snapshot.queued > 0) return `${base} (queued ${snapshot.queued})`;
  return base;
}

// Extra columns for the `workers` surface (text + --json): conc + usage.
export function buildParallelWorkersExtra(
  input: ParallelConc & { usage?: ParallelUsage },
): ParallelWorkersExtra {
  const extra: ParallelWorkersExtra = {
    running: input.running,
    queued: input.queued,
    maxConcurrency: input.maxConcurrency,
  };
  if (input.usage !== undefined) {
    extra.usage = { ...input.usage };
  }
  return extra;
}

// Plain-JSON trajectory record: conc, queue depth, FIFO wakeups, usage.
export function buildParallelTrajectoryEvent(
  input: ParallelSnapshot & { wakeups: string[]; usage?: ParallelUsage },
): ParallelTrajectoryEvent {
  const event: ParallelTrajectoryEvent = {
    kind: 'parallel',
    sessionId: input.sessionId,
    running: input.running,
    queued: input.queued,
    maxConcurrency: input.maxConcurrency,
    wakeups: [...input.wakeups],
  };
  if (input.usage !== undefined) {
    event.usage = { ...input.usage };
  }
  return event;
}
