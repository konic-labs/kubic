// Parallel scheduler (issue #47): conc 4 + FIFO queue vs fail-fast,
// one-worktree-per-writer, aggregates, provider/budget/approval gates,
// maxPendingMs-deny. RED first — implementation lands in scheduler.ts.
import { describe, expect, it } from 'vitest';
import { ParallelScheduler } from './scheduler.js';

function req(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    sessionId: 'sess-1',
    worktree: `/repo/.kubic/wt/${agentId}`,
    ...overrides,
  };
}

describe('parallel conc 4 + blocked-spawn modes (issue #47, §45.1)', () => {
  it('admits 4 parallel agents', () => {
    const sched = new ParallelScheduler();
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      expect(sched.requestSpawn(req(id), 'autonomous')).toMatchObject({
        outcome: 'admitted',
      });
    }
    expect(sched.runningCount()).toBe(4);
  });

  it('queues the 5th in autonomous mode', () => {
    const sched = new ParallelScheduler();
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      sched.requestSpawn(req(id), 'autonomous');
    }
    const fifth = sched.requestSpawn(req('a5'), 'autonomous');
    expect(fifth.outcome).toBe('queued');
    if (fifth.outcome === 'queued') expect(fifth.position).toBe(1);
  });

  it('fails the 5th with a reason in interactive mode', () => {
    const sched = new ParallelScheduler();
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      sched.requestSpawn(req(id), 'interactive');
    }
    const fifth = sched.requestSpawn(req('a5'), 'interactive');
    expect(fifth.outcome).toBe('denied');
    if (fifth.outcome === 'denied') {
      expect(fifth.reason).toMatch(/concurrency|capacity/i);
    }
  });

  it('honors a per-session concurrency override', () => {
    const sched = new ParallelScheduler({ maxConcurrency: 2 });
    sched.requestSpawn(req('a1'), 'autonomous');
    sched.requestSpawn(req('a2'), 'autonomous');
    expect(sched.requestSpawn(req('a3'), 'autonomous').outcome).toBe('queued');
  });
});

describe('parallel one-worktree-per-writer (issue #47, §11.1)', () => {
  it('refuses a second writer on the same worktree with a reason', () => {
    const sched = new ParallelScheduler();
    sched.requestSpawn(req('a1'), 'autonomous');
    const dup = sched.requestSpawn(
      req('a2', { worktree: '/repo/.kubic/wt/a1' }),
      'interactive',
    );
    expect(dup.outcome).toBe('denied');
    if (dup.outcome === 'denied') expect(dup.reason).toMatch(/worktree/);
  });

  it('frees the worktree on complete', () => {
    const sched = new ParallelScheduler();
    sched.requestSpawn(req('a1'), 'autonomous');
    sched.complete('a1');
    expect(
      sched.requestSpawn(
        req('a2', { worktree: '/repo/.kubic/wt/a1' }),
        'interactive',
      ).outcome,
    ).toBe('admitted');
  });
});

describe('parallel FIFO wakeup (issue #47)', () => {
  it('wakes the head of the queue first and logs it', () => {
    const logs: string[] = [];
    const sched = new ParallelScheduler({}, { log: (line) => logs.push(line) });
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      sched.requestSpawn(req(id), 'autonomous');
    }
    sched.requestSpawn(req('a5'), 'autonomous');
    sched.requestSpawn(req('a6'), 'autonomous');
    const woke = sched.complete('a1');
    expect(woke).toEqual(['a5']);
    expect(sched.runningCount()).toBe(4);
    expect(logs.some((l) => l.includes('a5') && /wake|admit/i.test(l))).toBe(
      true,
    );
  });

  it('never lets a later entry jump ahead of a still-blocked head', () => {
    const sched = new ParallelScheduler({ aggregates: { maxMemMb: 4096 } }, {});
    sched.requestSpawn(req('a1', { memMb: 2048 }), 'autonomous');
    sched.requestSpawn(req('a2', { memMb: 2048 }), 'autonomous');
    sched.requestSpawn(req('heavy', { memMb: 4096 }), 'autonomous');
    sched.requestSpawn(req('light', { memMb: 512 }), 'autonomous');
    sched.complete('a1');
    // head (heavy, 4096 > 2048 free) still blocked → light stays queued too
    expect(sched.pendingIds()).toEqual(['heavy', 'light']);
  });

  it('denies queued entries past maxPendingMs instead of hanging silent', () => {
    let now = 0;
    const logs: string[] = [];
    const sched = new ParallelScheduler(
      { maxPendingMs: 1000 },
      { clock: () => now, log: (line) => logs.push(line) },
    );
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      sched.requestSpawn(req(id), 'autonomous');
    }
    sched.requestSpawn(req('a5'), 'autonomous');
    now = 2000;
    const denied = sched.sweepPending();
    expect(denied).toEqual(['a5']);
    expect(sched.pendingIds()).toEqual([]);
    expect(logs.some((l) => l.includes('a5') && /expir|deny/i.test(l))).toBe(
      true,
    );
  });

  it('logs every enqueue — never a silent hang', () => {
    const logs: string[] = [];
    const sched = new ParallelScheduler({}, { log: (line) => logs.push(line) });
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      sched.requestSpawn(req(id), 'autonomous');
    }
    sched.requestSpawn(req('a5'), 'autonomous');
    expect(logs.some((l) => l.includes('a5') && /queue/i.test(l))).toBe(true);
  });
});

describe('parallel aggregate + approval gates (issue #47)', () => {
  it('blocks a 3rd heavy spawn on the mem aggregate in interactive mode', () => {
    const sched = new ParallelScheduler({
      maxConcurrency: 8,
      aggregates: { maxMemMb: 8192 },
    });
    sched.requestSpawn(req('h1', { memMb: 3072 }), 'interactive');
    sched.requestSpawn(req('h2', { memMb: 3072 }), 'interactive');
    const third = sched.requestSpawn(req('h3', { memMb: 3072 }), 'interactive');
    expect(third.outcome).toBe('denied');
    if (third.outcome === 'denied') expect(third.reason).toMatch(/mem/);
  });

  it('succeeds uncapped with no budgets configured (§71)', () => {
    const sched = new ParallelScheduler({ maxConcurrency: 8 });
    for (let i = 0; i < 8; i += 1) {
      const out = sched.requestSpawn(
        req(`heavy-${i}`, { memMb: 65536, costUsd: 9999 }),
        'interactive',
      );
      expect(out.outcome).toBe('admitted');
    }
  });

  it('gates approval-needing spawns on the single approval surface', () => {
    const sched = new ParallelScheduler(
      { maxConcurrency: 8, approvalCapacity: 1 },
      {},
    );
    expect(
      sched.requestSpawn(req('x1', { needsApproval: true }), 'interactive')
        .outcome,
    ).toBe('admitted');
    const second = sched.requestSpawn(
      req('x2', { needsApproval: true }),
      'interactive',
    );
    expect(second.outcome).toBe('denied');
    if (second.outcome === 'denied') expect(second.reason).toMatch(/approval/);
  });
});
