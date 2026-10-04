// §82 per-agent resource enforcement (issue #163): the memory and disk limits
// an admitted worker actually runs under, not just the estimates the admission
// layer compares. Pure: the probes (RSS, worktree size) arrive injected, the
// clock is injected, and nothing here touches a process or a file — so the
// policy is testable without real memory pressure.
//
// Wall clock is NOT here: a worker's `--timeout` (and the manager's
// `maxRuntimeMs` watchdog) already bounds it per worker.

export const RESOURCE_LIMIT_CODES = {
  memory: 'resource_memory_exceeded',
  disk: 'resource_disk_exceeded',
} as const;

export type ResourceKind = keyof typeof RESOURCE_LIMIT_CODES;

export interface ResourceLimits {
  /** Per-worker RSS cap in MB; absent means memory is not enforced. */
  memMb?: number;
  /** Per-worker worktree cap in MB; absent means disk is not enforced. */
  diskMb?: number;
}

export interface ResourceProbes {
  /** Resident memory of the worker's process group, in MB. Async because a
   *  real probe runs `ps` through the exec seam. */
  memoryMb?: (pid: number) => number | undefined | Promise<number | undefined>;
  /** Size of the worker's worktree, in MB (a real probe runs `du`). */
  diskMb?: (path: string) => number | undefined | Promise<number | undefined>;
}

export type ResourceBreach = {
  kind: ResourceKind;
  code: (typeof RESOURCE_LIMIT_CODES)[ResourceKind];
  limitMb: number;
  observedMb: number;
  message: string;
};

function breach(
  kind: ResourceKind,
  observedMb: number,
  limitMb: number,
  what: string,
): ResourceBreach {
  return {
    kind,
    code: RESOURCE_LIMIT_CODES[kind],
    limitMb,
    observedMb,
    message: `${what} limit exceeded for worker: ${observedMb}MB >= ${limitMb}MB (${RESOURCE_LIMIT_CODES[kind]})`,
  };
}

/** Memory verdict: a reading at or above the cap is a breach. */
export function checkMemoryLimit(
  rssMb: number | undefined,
  limitMb: number | undefined,
): ResourceBreach | undefined {
  if (rssMb === undefined || limitMb === undefined) return undefined;
  if (rssMb < limitMb) return undefined;
  return breach('memory', rssMb, limitMb, 'memory');
}

/** Disk verdict: a worktree at or above the quota is a breach. */
export function checkDiskLimit(
  usedMb: number | undefined,
  quotaMb: number | undefined,
): ResourceBreach | undefined {
  if (usedMb === undefined || quotaMb === undefined) return undefined;
  if (usedMb < quotaMb) return undefined;
  return breach('disk', usedMb, quotaMb, 'worktree disk');
}

// Which limits this build can actually enforce (issue #163, §82): a limit
// with no probe is NOT enforced, and saying so is the point — `kubic doctor`
// reports exactly this table.
export interface EnforcedLimits {
  wallClock: true;
  memory: boolean;
  disk: boolean;
}

export function enforcedLimits(
  probes: ResourceProbes,
  limits: ResourceLimits = {},
): EnforcedLimits {
  return {
    // The per-worker `--timeout` (and the manager's runtime watchdog) always
    // bound a worker's wall clock — no probe is involved.
    wallClock: true,
    // A configured limit without its probe cannot be enforced, and an
    // available probe with no configured limit enforces nothing.
    memory: limits.memMb !== undefined && probes.memoryMb !== undefined,
    disk: limits.diskMb !== undefined && probes.diskMb !== undefined,
  };
}

export interface ResourceWatchdogDeps {
  limits: ResourceLimits;
  probes: ResourceProbes;
  /** Poll cadence; the default is one second. */
  pollMs?: number;
  /** The worker's pid (memory sampling) and worktree (disk sampling). */
  pid: () => number | undefined;
  worktree: string;
  /** Called ONCE, with the first breach. */
  onBreach: (breach: ResourceBreach) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface ResourceWatchdog {
  /** One poll, as the interval runs it; exported for deterministic tests. */
  poll: () => Promise<ResourceBreach | undefined>;
  stop: () => void;
}

export const DEFAULT_RESOURCE_POLL_MS = 1_000;

/**
 * The runtime half of §82 (issue #163): sample the worker's RSS and its
 * worktree size on an interval and report the FIRST breach. The caller owns
 * what a breach does (the lifecycle layer reaps the worker with the named
 * code); this only decides. A limit whose probe is missing is skipped, never
 * guessed — `enforcedLimits` reports that posture.
 */
export function createResourceWatchdog(
  deps: ResourceWatchdogDeps,
): ResourceWatchdog {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  let stopped = false;
  let breachReported = false;
  const poll = async (): Promise<ResourceBreach | undefined> => {
    if (stopped) return undefined;
    let memoryReading: number | undefined;
    if (deps.limits.memMb !== undefined && deps.probes.memoryMb !== undefined) {
      memoryReading = await deps.probes.memoryMb(deps.pid() ?? -1);
    }
    const memory = checkMemoryLimit(memoryReading, deps.limits.memMb);
    let disk: ResourceBreach | undefined;
    if (
      memory === undefined &&
      deps.limits.diskMb !== undefined &&
      deps.probes.diskMb !== undefined
    ) {
      disk = checkDiskLimit(
        await deps.probes.diskMb(deps.worktree),
        deps.limits.diskMb,
      );
    }
    const found = memory ?? disk;
    if (found !== undefined && !breachReported) {
      breachReported = true;
      deps.onBreach(found);
    }
    return found;
  };
  const timer = setIntervalFn(() => {
    void poll();
  }, deps.pollMs ?? DEFAULT_RESOURCE_POLL_MS);
  timer.unref?.();
  return {
    poll,
    stop: () => {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
