// Crash recovery for the durable worker rows (§50, §51): a manager that died
// hard (SIGKILL, crash) leaves rows marked live. They are reconciled, never
// trusted: a dead pid is marked crashed, a live worker whose manager is gone
// is killed — but only when its command line proves it is still OUR worker
// (pid reuse guard) — and a row whose manager is alive is left alone.
import { describe, expect, it } from 'vitest';
import {
  isLiveWorkerRow,
  type ProcessProbe,
  reconcileWorkerRows,
  viewWorkerRows,
} from './orphans.js';
import type { WorkerRow } from './registry.js';

function row(over: Partial<WorkerRow>): WorkerRow {
  return {
    workerId: 'w1',
    sessionId: 'orch-1-w1',
    generation: 1,
    status: 'ready',
    agentStatus: 'running',
    startedAtMs: 0,
    ageMs: 0,
    owner: 'orchestrate:orch-1',
    pid: 100,
    managerPid: 50,
    ...over,
  };
}

function probe(
  alive: number[],
  commands: Record<number, string> = {},
): ProcessProbe & { killed: number[] } {
  const killed: number[] = [];
  return {
    alive: (pid) => alive.includes(pid),
    command: async (pid) => commands[pid],
    killGroup: (pid) => {
      killed.push(pid);
    },
    killed,
  };
}

describe('reconcileWorkerRows', () => {
  it('marks a live-status row with a dead pid and a dead manager crashed', async () => {
    const p = probe([]);
    const out = await reconcileWorkerRows([row({})], p);
    expect(out.rows[0]).toMatchObject({
      status: 'exiting',
      agentStatus: 'failed',
    });
    expect(out.marked).toEqual(['w1']);
    expect(p.killed).toEqual([]);
  });

  it('kills an orphaned worker whose command proves it is ours', async () => {
    const p = probe([100], {
      100: 'node kubic.js run -p x --session orch-1-w1 --json',
    });
    const out = await reconcileWorkerRows([row({})], p);
    expect(p.killed).toEqual([100]);
    expect(out.rows[0]).toMatchObject({
      status: 'exiting',
      agentStatus: 'cancelled',
    });
    expect(out.reaped).toEqual(['w1']);
  });

  it('never kills a reused pid that is not our worker', async () => {
    const p = probe([100], { 100: '/usr/bin/vim notes.txt' });
    const out = await reconcileWorkerRows([row({})], p);
    expect(p.killed).toEqual([]);
    expect(out.rows[0]).toMatchObject({
      status: 'exiting',
      agentStatus: 'failed',
    });
  });

  it('leaves rows whose manager is still alive untouched', async () => {
    const p = probe([100, 50], { 100: 'run --session orch-1-w1' });
    const out = await reconcileWorkerRows([row({})], p);
    expect(p.killed).toEqual([]);
    expect(out.rows[0]?.status).toBe('ready');
    expect(out.rows[0]?.agentStatus).toBe('running');
  });

  it('leaves terminal rows untouched', async () => {
    const p = probe([]);
    const out = await reconcileWorkerRows(
      [row({ status: 'exiting', agentStatus: 'completed' })],
      p,
    );
    expect(out.rows[0]?.agentStatus).toBe('completed');
    expect(out.marked).toEqual([]);
  });
});

describe('viewWorkerRows (sync, read-only)', () => {
  it('shows a dead orphan as crashed without killing anything', () => {
    expect(viewWorkerRows([row({})], (pid) => pid === 50)[0]?.status).toBe(
      'ready',
    );
    expect(viewWorkerRows([row({})], () => false)[0]).toMatchObject({
      status: 'exiting',
      agentStatus: 'failed',
    });
  });
});

describe('isLiveWorkerRow', () => {
  it('is live only for a non-terminal row with a live pid', () => {
    expect(isLiveWorkerRow(row({}), (pid) => pid === 100)).toBe(true);
    expect(isLiveWorkerRow(row({}), () => false)).toBe(false);
    expect(
      isLiveWorkerRow(
        row({ status: 'exiting', agentStatus: 'completed' }),
        (pid) => pid === 100,
      ),
    ).toBe(false);
  });
});
