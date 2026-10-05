// reap = zombie-free, <1s, non-blocking (issue #42; §61 teardown):
// kill lands synchronously, the exit report (code/signal)
// settles async, and the caller never blocks on the child.
import { describe, expect, it } from 'vitest';
import { reapDetached, reportExit } from './reap.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('reportExit (issue #42)', () => {
  it('reports code and signal together (no leak count — issue #246)', () => {
    const report = reportExit({ code: 1, signal: 'SIGKILL' });
    expect(report).toEqual({
      kind: 'crash',
      status: 'failed',
      code: 1,
      signal: 'SIGKILL',
    });
    // The always-0 leak count is dropped from the exit report (issue
    // #246): nothing ever measured it, so the report carries no key.
    expect(report).not.toHaveProperty('leakedHandles');
  });

  it('reports a clean exit', () => {
    expect(reportExit({ code: 0, signal: null })).toMatchObject({
      kind: 'completed',
      status: 'completed',
    });
  });
});

describe('reapDetached (issue #42)', () => {
  it('kills synchronously and settles the report async (non-blocking)', async () => {
    const gate = deferred<{ code: number }>();
    const kills: string[] = [];
    // Injected clock: the initiate span is exactly the ticks around kill.
    const ticks = [100, 103];
    const pending = reapDetached(
      {
        workerId: 'w-1',
        kill: () => kills.push('w-1'),
        wait: () => gate.promise,
      },
      { clock: () => ticks.shift() ?? 0 },
    );
    // Non-blocking: kill fired before any await drains the child, and the
    // report is still pending while the child has not exited.
    expect(kills).toEqual(['w-1']);
    expect(pending.teardownInitiateMs).toBe(3);
    let settled = false;
    void pending.reaped.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve({ code: 0 });
    const report = await pending.reaped;
    expect(report.kind).toBe('completed');
    expect(report.timedOut).toBeUndefined();
  });

  it('marks the reap timed-out past 1s but still drains the child', async () => {
    const gate = deferred<{ code: number }>();
    const pending = reapDetached(
      { workerId: 'w-2', kill: () => undefined, wait: () => gate.promise },
      { clock: () => 0, settleTimeoutMs: 5 },
    );
    const first = await pending.reaped;
    expect(first.timedOut).toBe(true);
    expect(first.kind).toBe('timeout');
    gate.resolve({ code: 0 });
    const drained = await pending.drained;
    expect(drained.kind).toBe('completed');
  });
});
