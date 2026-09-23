// Worker reap (issue #42; §61 teardown, §51): zombie-free, <1s,
// non-blocking. reapDetached kills synchronously and returns at once —
// the exit report (code/signal/leaks) settles on .reaped, with a
// past-budget flag when the child outlives the teardown budget. The
// child is always drained (.drained), so no zombies even on timeout.
// Cancelled workers (§51) are terminated here and never reused: reap
// removes the proc, it never recycles it.

import { classifyExit, type ExitResultStatus } from './status.js';

export interface RawExit {
  code: number | null;
  signal: string | null;
  leakedHandles: number;
}

export interface ExitReport extends RawExit {
  kind:
    | 'completed'
    | 'crash'
    | 'tool'
    | 'budget'
    | 'cancel'
    | 'timeout'
    | 'spawn_failed';
  status: ExitResultStatus;
  timedOut?: boolean;
}

export function reportExit(raw: RawExit): ExitReport {
  const classified = classifyExit({
    code: raw.code,
    signal: raw.signal,
    cancelled: false,
  });
  return {
    code: raw.code,
    signal: raw.signal,
    leakedHandles: raw.leakedHandles,
    kind: classified.kind,
    status: classified.status,
  };
}

export interface ReapTarget {
  workerId: string;
  kill: () => void;
  wait: () => Promise<{ code: number | null; signal?: string | null }>;
  leakedHandles?: number;
  cancelled?: boolean;
}

export interface ReapDeps {
  clock?: () => number;
  settleTimeoutMs?: number;
}

export interface DetachedReap {
  teardownInitiateMs: number;
  reaped: Promise<ExitReport>;
  drained: Promise<ExitReport>;
}

export const TEARDOWN_BUDGET_MS = 1000;

export function reapDetached(
  target: ReapTarget,
  deps?: ReapDeps,
): DetachedReap {
  const clock = deps?.clock ?? Date.now;
  const settleTimeoutMs = deps?.settleTimeoutMs ?? TEARDOWN_BUDGET_MS;
  const startedAt = clock();
  target.kill();
  const teardownInitiateMs = clock() - startedAt;

  const drain = async (): Promise<ExitReport> => {
    const done = await target.wait();
    const classified = classifyExit({
      code: done.code,
      signal: done.signal ?? null,
      cancelled: target.cancelled ?? false,
    });
    return {
      code: done.code,
      signal: done.signal ?? null,
      leakedHandles: target.leakedHandles ?? 0,
      kind: classified.kind,
      status: classified.status,
    };
  };
  const drained = drain();
  // Both .reaped and .drained observe the same drain: mark handled so a
  // wait failure never surfaces as an unhandled rejection on the twin.
  drained.catch(() => undefined);

  const reaped = (async (): Promise<ExitReport> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), settleTimeoutMs);
      });
      const outcome = await Promise.race([drained, timeout]);
      if ('timedOut' in outcome) {
        return {
          code: null,
          signal: null,
          leakedHandles: target.leakedHandles ?? 0,
          kind: 'timeout',
          status: 'timeout',
          timedOut: true,
        };
      }
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();

  return { teardownInitiateMs, reaped, drained };
}
