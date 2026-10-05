// Parallel scheduler (issue #47): conc 4 + FIFO queue vs fail-fast,
// one-worktree-per-writer, aggregates, provider/budget/approval gates,
// maxPendingMs-deny. RED first — implementation lands in scheduler.ts.
import { describe, expect, it } from 'vitest';
import { ParallelScheduler, sanitizeLogLine } from './scheduler.js';

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

describe('parallel configured default (issue #133)', () => {
  it('judges admissions against [orchestrator].maxWorkers', () => {
    const sched = new ParallelScheduler(undefined, {
      configured: { maxWorkers: 2 },
    });
    expect(sched.maxConcurrency()).toBe(2);
    expect(sched.requestSpawn(req('a1'), 'autonomous').outcome).toBe(
      'admitted',
    );
    expect(sched.requestSpawn(req('a2'), 'autonomous').outcome).toBe(
      'admitted',
    );
    // The configured default is a real cap, not a report: the third queues.
    expect(sched.requestSpawn(req('a3'), 'autonomous').outcome).toBe('queued');
  });

  it('lets an explicit session override beat the configured default', () => {
    const sched = new ParallelScheduler(undefined, {
      sessionOverride: 1,
      configured: { maxWorkers: 4 },
    });
    expect(sched.maxConcurrency()).toBe(1);
    expect(sched.requestSpawn(req('a1'), 'autonomous').outcome).toBe(
      'admitted',
    );
    expect(sched.requestSpawn(req('a2'), 'autonomous').outcome).toBe('queued');
  });

  it('keeps the shipped cap when no configured default is present', () => {
    const sched = new ParallelScheduler(undefined, { configured: {} });
    expect(sched.maxConcurrency()).toBe(4);
  });

  it('fails construction on a configured value that could never admit a worker', () => {
    expect(
      () => new ParallelScheduler(undefined, { configured: { maxWorkers: 0 } }),
    ).toThrow(/orchestrator\.maxWorkers must be a positive integer/);
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
    expect(sched.pendingIds()).toEqual(['a6']);
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

describe('parallel provider stamp pruning (issue #47 review)', () => {
  it('bounds the stamp array after many admits across windows', () => {
    let now = 0;
    const sched = new ParallelScheduler(
      {
        maxConcurrency: 100,
        maxPendingMs: 600_000,
        providerCaps: { acme: { maxPerWindow: 10_000, windowMs: 1000 } },
      },
      { clock: () => now },
    );
    for (let i = 0; i < 20; i += 1) {
      now = i * 500;
      const out = sched.requestSpawn(
        req(`p${i}`, { provider: 'acme' }),
        'interactive',
      );
      expect(out.outcome).toBe('admitted');
    }
    const stamps = (
      sched as unknown as { providerStamps: Map<string, number[]> }
    ).providerStamps.get('acme');
    // Only admits inside the trailing 1000ms window survive (t=9000, t=9500).
    expect(stamps?.length).toBe(2);
  });

  it('drops stamp buckets entirely once fully outside the window', () => {
    let now = 0;
    const sched = new ParallelScheduler(
      {
        maxConcurrency: 100,
        providerCaps: { acme: { maxPerWindow: 10_000, windowMs: 1000 } },
      },
      { clock: () => now },
    );
    sched.requestSpawn(req('p0', { provider: 'acme' }), 'interactive');
    now = 60_000;
    sched.sweepPending();
    const stamps = (
      sched as unknown as { providerStamps: Map<string, number[]> }
    ).providerStamps.get('acme');
    expect(stamps).toBeUndefined();
  });
});

describe('parallel time-freed drain on spawn (issue #47 review)', () => {
  it('admits a queued head on a new spawn after the rate window passes, without expiry', () => {
    let now = 0;
    const sched = new ParallelScheduler(
      {
        maxConcurrency: 8,
        maxPendingMs: 600_000,
        providerCaps: { acme: { maxPerWindow: 1, windowMs: 1000 } },
      },
      { clock: () => now },
    );
    expect(
      sched.requestSpawn(req('a1', { provider: 'acme' }), 'autonomous').outcome,
    ).toBe('admitted');
    expect(
      sched.requestSpawn(req('a2', { provider: 'acme' }), 'autonomous').outcome,
    ).toBe('queued');
    now = 100;
    sched.complete('a1');
    // Still in-window: head stays queued even with nothing running.
    expect(sched.pendingIds()).toEqual(['a2']);
    // Window passes; the next spawn re-evaluates the head first.
    now = 1200;
    const third = sched.requestSpawn(
      req('a3', { provider: 'acme' }),
      'autonomous',
    );
    expect(third.outcome).toBe('queued');
    expect(sched.runningIds()).toContain('a2');
    expect(sched.pendingIds()).toEqual(['a3']);
  });
});

describe('parallel construction validation (issue #47 review)', () => {
  it('throws on a negative maxPendingMs', () => {
    expect(() => new ParallelScheduler({ maxPendingMs: -1 })).toThrow(
      /maxPendingMs/,
    );
  });

  it('throws on zero/negative provider caps', () => {
    expect(
      () =>
        new ParallelScheduler({
          providerCaps: { acme: { maxConcurrent: 0 } },
        }),
    ).toThrow(/maxConcurrent/);
    expect(
      () =>
        new ParallelScheduler({
          providerCaps: { acme: { maxPerWindow: -2 } },
        }),
    ).toThrow(/maxPerWindow/);
    expect(
      () => new ParallelScheduler({ providerCaps: { acme: { windowMs: 0 } } }),
    ).toThrow(/windowMs/);
  });

  it('throws on zero/negative budget and aggregate caps', () => {
    expect(
      () => new ParallelScheduler({ budgetGate: { maxCostUsd: 0 } }),
    ).toThrow(/maxCostUsd/);
    expect(
      () => new ParallelScheduler({ budgetGate: { maxTokens: -5 } }),
    ).toThrow(/maxTokens/);
    expect(
      () => new ParallelScheduler({ aggregates: { maxMemMb: 0 } }),
    ).toThrow(/maxMemMb/);
    expect(() => new ParallelScheduler({ approvalCapacity: -1 })).toThrow(
      /approvalCapacity/,
    );
  });
});

describe('parallel budget updateUsage (issue #47 review)', () => {
  it('wakes a budget-queued head after fresh usage arrives', () => {
    const sched = new ParallelScheduler(
      { maxConcurrency: 8, budgetGate: { maxCostUsd: 5 } },
      { usage: { costUsd: 10 } },
    );
    expect(sched.requestSpawn(req('b1'), 'autonomous').outcome).toBe('queued');
    const woken = sched.updateUsage({ costUsd: 1 });
    expect(woken).toEqual(['b1']);
    expect(sched.pendingIds()).toEqual([]);
    expect(sched.runningIds()).toContain('b1');
  });

  it('denied → updated → admitted in interactive mode', () => {
    const sched = new ParallelScheduler(
      { maxConcurrency: 8, budgetGate: { maxCostUsd: 5 } },
      { usage: { costUsd: 10 } },
    );
    const denied = sched.requestSpawn(req('b1'), 'interactive');
    expect(denied.outcome).toBe('denied');
    sched.updateUsage({ costUsd: 1 });
    expect(sched.requestSpawn(req('b1'), 'interactive').outcome).toBe(
      'admitted',
    );
  });
});

describe('parallel budget gate installation (issue #207)', () => {
  it('setBudgetGate installs the aggregate gate on a live scheduler', () => {
    const sched = new ParallelScheduler({ maxConcurrency: 8 });
    expect(sched.requestSpawn(req('b1'), 'autonomous').outcome).toBe(
      'admitted',
    );
    sched.setBudgetGate({ maxCostUsd: 5 });
    sched.updateUsage({ costUsd: 10 });
    const denied = sched.requestSpawn(req('b2'), 'interactive');
    expect(denied.outcome).toBe('denied');
    if (denied.outcome === 'denied') {
      expect(denied.reason).toMatch(/budget cost gate/);
    }
  });

  it('setBudgetGate validates eagerly and removes the override on undefined', () => {
    const sched = new ParallelScheduler();
    expect(() => sched.setBudgetGate({ maxCostUsd: 0 })).toThrow(/maxCostUsd/);
    sched.setBudgetGate({ maxCostUsd: 5 });
    sched.setBudgetGate(undefined);
    sched.updateUsage({ costUsd: 10 });
    expect(sched.requestSpawn(req('b1'), 'autonomous').outcome).toBe(
      'admitted',
    );
  });
});

describe('parallel log sanitizing (issue #47 review)', () => {
  it('strips control characters from queue logs for a crafted agentId', () => {
    const logs: string[] = [];
    const sched = new ParallelScheduler(
      { maxConcurrency: 1 },
      { log: (line: string) => logs.push(line) },
    );
    sched.requestSpawn(req('ok'), 'autonomous');
    const evil = 'evil-\u001b[31m-red';
    expect(sched.requestSpawn(req(evil), 'autonomous').outcome).toBe('queued');
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line.includes('\u001b')).toBe(false);
      expect(line.includes('\n')).toBe(false);
    }
    expect(logs.some((l) => l.includes('evil-') && l.includes('-red'))).toBe(
      true,
    );
  });

  it('strips escape sequences from deny logs for a crafted worktree', () => {
    const logs: string[] = [];
    const sched = new ParallelScheduler(
      {},
      { log: (line: string) => logs.push(line) },
    );
    const evilWt = '/repo/.kubic/wt/evil\u001b[2J-inject';
    sched.requestSpawn(
      { agentId: 'w1', sessionId: 'sess-1', worktree: evilWt },
      'autonomous',
    );
    const dup = sched.requestSpawn(
      { agentId: 'w2', sessionId: 'sess-1', worktree: evilWt },
      'interactive',
    );
    expect(dup.outcome).toBe('denied');
    // The deny itself is logged — the scan below covers that line.
    expect(logs.some((l) => l.includes('w2'))).toBe(true);
    for (const line of logs) {
      expect(line.includes('\u001b')).toBe(false);
    }
  });

  it('returns deny reasons already sanitized for a crafted agentId (sanitize-at-source)', () => {
    const sched = new ParallelScheduler();
    const evilAgent = 'a\u001b[2Jb';
    const first = sched.requestSpawn(
      {
        agentId: evilAgent,
        sessionId: 'sess-1',
        worktree: '/repo/.kubic/wt/evil-one',
      },
      'autonomous',
    );
    expect(first.outcome).toBe('admitted');
    const dup = sched.requestSpawn(
      {
        agentId: evilAgent,
        sessionId: 'sess-1',
        worktree: '/repo/.kubic/wt/evil-two',
      },
      'interactive',
    );
    expect(dup.outcome).toBe('denied');
    if (dup.outcome === 'denied') {
      expect(dup.reason.includes('\u001b')).toBe(false);
      expect(dup.reason.includes(evilAgent)).toBe(false);
    }
  });

  it('returns deny reasons already sanitized for a crafted worktree (sanitize-at-source)', () => {
    const sched = new ParallelScheduler();
    const evilWt = '/repo/.kubic/wt/evil\u001b[2J-inject';
    sched.requestSpawn(
      { agentId: 'w1', sessionId: 'sess-1', worktree: evilWt },
      'autonomous',
    );
    const dup = sched.requestSpawn(
      { agentId: 'w2', sessionId: 'sess-1', worktree: evilWt },
      'interactive',
    );
    expect(dup.outcome).toBe('denied');
    if (dup.outcome === 'denied') {
      expect(dup.reason.includes('\u001b')).toBe(false);
      expect(dup.reason.includes(evilWt)).toBe(false);
    }
  });

  it('sanitizeLogLine strips single-char C1 CSI (U+009B)', () => {
    const out = sanitizeLogLine('a\u009Bb');
    expect([...out].map((ch) => ch.codePointAt(0))).toEqual([0x61, 0x62]);
  });

  it('sanitizeLogLine strips NEL (U+0085)', () => {
    const out = sanitizeLogLine('a\u0085b');
    expect([...out].map((ch) => ch.codePointAt(0))).toEqual([0x61, 0x62]);
  });

  it('sanitizeLogLine strips bidi overrides (U+202E)', () => {
    const out = sanitizeLogLine('a\u202Eb');
    expect([...out].map((ch) => ch.codePointAt(0))).toEqual([0x61, 0x62]);
  });

  it('sanitizeLogLine removes C0 controls and DEL', () => {
    expect(sanitizeLogLine('a\u001fb\u007fc')).toBe('abc');
  });
});

describe('withdraw (issue #414 review)', () => {
  it('withdraws a queued entry so a later drain never admits the ghost', () => {
    const sched = new ParallelScheduler({ maxConcurrency: 1 });
    expect(sched.requestSpawn(req('a1'), 'autonomous')).toMatchObject({
      outcome: 'admitted',
    });
    expect(sched.requestSpawn(req('a2'), 'autonomous')).toMatchObject({
      outcome: 'queued',
    });
    expect(sched.withdraw('a2')).toBe('withdrawn');
    expect(sched.pendingIds()).toEqual([]);
    // The freed slot goes to new work, never to the withdrawn ghost.
    sched.complete('a1');
    expect(sched.runningIds()).toEqual([]);
    expect(sched.requestSpawn(req('a3'), 'autonomous')).toMatchObject({
      outcome: 'admitted',
    });
  });

  it('reports running when the entry was just admitted', () => {
    const sched = new ParallelScheduler({ maxConcurrency: 1 });
    sched.requestSpawn(req('a1'), 'autonomous');
    expect(sched.withdraw('a1')).toBe('running');
    expect(sched.runningIds()).toEqual(['a1']);
  });

  it('reports unknown for an id it never held', () => {
    const sched = new ParallelScheduler();
    expect(sched.withdraw('nobody')).toBe('unknown');
  });
});
