// §82 per-agent resource enforcement (issue #163): the limits a worker
// actually runs under, not just the estimates admission compares.
import { describe, expect, it, vi } from 'vitest';
import type { ResourceBreach } from './resources.js';
import {
  checkDiskLimit,
  checkMemoryLimit,
  createResourceWatchdog,
  enforcedLimits,
  RESOURCE_LIMIT_CODES,
} from './resources.js';

describe('resource limits (§82, issue #163)', () => {
  it('breaches at or above the cap, and never below it', () => {
    expect(checkMemoryLimit(499, 500)).toBeUndefined();
    expect(checkMemoryLimit(500, 500)).toMatchObject({
      kind: 'memory',
      code: 'resource_memory_exceeded',
      observedMb: 500,
      limitMb: 500,
    });
    expect(checkDiskLimit(10, 5)).toMatchObject({
      kind: 'disk',
      code: 'resource_disk_exceeded',
    });
  });

  it('reports nothing without a limit or without a reading', () => {
    expect(checkMemoryLimit(9_000, undefined)).toBeUndefined();
    expect(checkMemoryLimit(undefined, 100)).toBeUndefined();
    expect(checkDiskLimit(undefined, 1)).toBeUndefined();
    expect(checkDiskLimit(1, undefined)).toBeUndefined();
  });

  it('pins the named resource codes', () => {
    expect(RESOURCE_LIMIT_CODES).toEqual({
      memory: 'resource_memory_exceeded',
      disk: 'resource_disk_exceeded',
    });
  });

  it('reports which limits are enforced — a limit without its probe is not', () => {
    expect(enforcedLimits({}, {})).toEqual({
      wallClock: true,
      memory: false,
      disk: false,
    });
    expect(
      enforcedLimits({ memoryMb: () => 1, diskMb: () => 1 }, { memMb: 10 }),
    ).toEqual({ wallClock: true, memory: true, disk: false });
    // A probe with no configured limit enforces nothing either.
    expect(enforcedLimits({ memoryMb: () => 1 }, {})).toMatchObject({
      memory: false,
    });
  });

  it('reports the FIRST breach once and stops sampling after stop()', async () => {
    const breaches: string[] = [];
    const timer = { unref: () => undefined } as unknown as ReturnType<
      typeof setInterval
    >;
    const watchdog = createResourceWatchdog({
      limits: { memMb: 100 },
      probes: { memoryMb: () => 250 },
      pid: () => 42,
      worktree: '/tmp/wt',
      onBreach: (found) => breaches.push(found.code),
      setIntervalFn: (() => timer) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(await watchdog.poll()).toMatchObject({
      code: 'resource_memory_exceeded',
    });
    // The callback fires once — a second poll is the same breach, not a new one.
    expect(await watchdog.poll()).toMatchObject({
      code: 'resource_memory_exceeded',
    });
    expect(breaches).toEqual(['resource_memory_exceeded']);
    watchdog.stop();
    expect(await watchdog.poll()).toBeUndefined();
  });

  it('checks disk when memory is within its cap, and skips unenforceable limits', async () => {
    const breaches: string[] = [];
    const timer = { unref: () => undefined } as unknown as ReturnType<
      typeof setInterval
    >;
    const watchdog = createResourceWatchdog({
      limits: { memMb: 100, diskMb: 10 },
      probes: { memoryMb: () => 50, diskMb: () => 900 },
      pid: () => 42,
      worktree: '/tmp/wt',
      onBreach: (found) => breaches.push(found.code),
      setIntervalFn: (() => timer) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(await watchdog.poll()).toMatchObject({
      code: 'resource_disk_exceeded',
    });
    watchdog.stop();

    const unenforceable = createResourceWatchdog({
      limits: { memMb: 1 },
      probes: {},
      pid: () => 42,
      worktree: '/tmp/wt',
      onBreach: () => undefined,
      setIntervalFn: (() => timer) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(await unenforceable.poll()).toBeUndefined();
    unenforceable.stop();
  });

  it('runs the poll on the injected interval and clears it on stop', async () => {
    const tick = vi.fn();
    const clear = vi.fn();
    const timer = { unref: () => undefined } as unknown as ReturnType<
      typeof setInterval
    >;
    const watchdog = createResourceWatchdog({
      limits: { memMb: 100 },
      probes: { memoryMb: () => 250 },
      pid: () => 1,
      worktree: '/tmp/wt',
      onBreach: tick,
      pollMs: 5,
      setIntervalFn: ((handler: () => void) => {
        handler();
        return timer;
      }) as unknown as typeof setInterval,
      clearIntervalFn: clear as unknown as typeof clearInterval,
    });
    // The interval handler polls asynchronously; wait for the breach.
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    watchdog.stop();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

describe('watchdog robustness (issue #163 review)', () => {
  it('swallows a throwing probe instead of rejecting out of the interval', async () => {
    const breaches: ResourceBreach[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let calls = 0;
    const watchdog = createResourceWatchdog({
      limits: { memMb: 100 },
      probes: {
        memoryMb: () => {
          calls += 1;
          if (calls > 1) throw new Error('probe died');
          return 50;
        },
      },
      pid: () => 1,
      worktree: '/tmp/wt',
      onBreach: (breach) => breaches.push(breach),
      pollMs: 1,
    });
    try {
      await watchdog.poll();
      // The interval keeps firing: the second poll throws inside the guard.
      await new Promise((resolve) => setTimeout(resolve, 20));
      watchdog.stop();
      // Give any unhandled rejection a turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(calls).toBeGreaterThan(1);
    expect(unhandled).toEqual([]);
  });
});
