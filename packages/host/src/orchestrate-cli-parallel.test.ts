// Parallel surfacing and concurrency on the live orchestrate path (issue
// #106, §49.1/§50; issue #206, §9.3/§45).
// RED first: the run consults the ParallelScheduler per spawn but its
// running/queued counts never reached the operator, and no parallel event was
// ever built. These tests drive the REAL `runOrchestrateCommand` against the
// REAL `ParallelScheduler` — the numbers asserted are measured from the run,
// never assumed. Since #206 the admission layer is a GATE: admitted workers
// run concurrently up to the resolved cap, the rest wait in the scheduler
// queue and are drained when a slot is released.
import { describe, expect, it, vi } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from './orchestrate-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';
import type { ParallelTrajectoryEvent } from './orchestrator/parallel/visibility.js';

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  merged: string[];
  saved: OrchestratorRunState[];
}

function makeWorld(overrides: Partial<OrchestrateCommandDeps> = {}): FakeWorld {
  const lines: string[] = [];
  const merged: string[] = [];
  const saved: OrchestratorRunState[] = [];
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  const deps: OrchestrateCommandDeps = {
    out: (line: string) => {
      lines.push(line);
    },
    err: (line: string) => {
      lines.push(line);
    },
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string): OrchestrateWorktree => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: () => hunks,
    mergeBranch: (agentId: string) => {
      merged.push(agentId);
    },
    reapWorker: () => undefined,
    requestApproval: () => true,
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
    ...overrides,
  };
  return { deps, lines, merged, saved };
}

function lastJsonLine(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1] as string) as Record<
    string,
    unknown
  >;
}

// A latch the test owns: a worker's run blocks on `promise` until the test
// resolves it, so overlap/cap/order are measured instead of assumed.
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const hunksFor = (agentId: string): MergedHunk[] => [
  { path: `${agentId}.txt`, hunk: `@@ -0,0 +1 @@ +${agentId}` },
];

// A world whose workers block on per-agent latches the test releases.
function latchWorld(
  gates: Map<string, Deferred>,
  started: string[],
  overrides: Partial<OrchestrateCommandDeps> = {},
): FakeWorld {
  return makeWorld({
    runWorker: (agentId: string) => {
      started.push(agentId);
      const gate = deferred();
      gates.set(agentId, gate);
      return gate.promise.then(() => hunksFor(agentId));
    },
    ...overrides,
  });
}

describe('orchestrate parallel surfacing (issue #106, §49.1/§50)', () => {
  it('carries running/queued/cap in the --json envelope when agents exceed the cap', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    // Measured, not assumed (issue #206): the loop admits up to the resolved
    // cap, so six agents against the default cap of four reach a running
    // high-water of 4 and queue the remaining two.
    expect(lastJsonLine(world.lines).parallel).toEqual({
      running: 4,
      queued: 2,
      maxConcurrency: 4,
    });
    expect(world.merged).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('prints the running/queued/cap numbers on the text output', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.lines).toContain('parallel: running 4 queued 2 cap 4');
    // The §49.1 agent-tree line the counts belong to.
    expect(world.lines).toContain('tree: sess-1 parallel 4/4 (queued 2)');
  });

  it('queues past the cap and records the FIFO wakeup when a slot frees', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const events: ParallelTrajectoryEvent[] = [];
    // The run's own `--concurrency 1`: the option is applied to the injected
    // scheduler (the one every admission judgement goes through), so one
    // worker runs at a time and three agents queue two.
    const scheduler = new ParallelScheduler();
    const world = latchWorld(gates, started, {
      scheduler,
      trajectoryEvent: (event) => {
        events.push(event);
      },
    });
    const running = runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2', 'a3'],
        session: 'sess-1',
        yes: true,
        json: true,
        concurrency: 1,
      },
      world.deps,
    );
    // The admission layer is a GATE now: only the admitted worker starts and
    // the other two wait, so the run cannot finish on its own.
    await vi.waitFor(() => expect(started).toEqual(['a1']));
    expect(scheduler.maxConcurrency()).toBe(1);
    expect(scheduler.runningCount()).toBe(1);
    expect(scheduler.queuedCount()).toBe(2);
    expect(events.map((event) => event.wakeups)).toEqual([[], []]);

    gates.get('a1')?.resolve();
    await vi.waitFor(() => expect(started).toEqual(['a1', 'a2']));
    gates.get('a2')?.resolve();
    await vi.waitFor(() => expect(started).toEqual(['a1', 'a2', 'a3']));
    gates.get('a3')?.resolve();

    expect(await running).toBe(0);
    // Each release wakes exactly the FIFO head, and the wakeup is recorded.
    expect(events.map((event) => event.wakeups)).toEqual([
      [],
      [],
      ['a2'],
      ['a3'],
    ]);
    expect(world.merged).toEqual(['a1', 'a2', 'a3']);
    expect(lastJsonLine(world.lines).parallel).toEqual({
      running: 1,
      queued: 2,
      maxConcurrency: 1,
    });
  });
});

describe('orchestrate worker concurrency (issue #206, §9.3/§45)', () => {
  it('runs two admitted workers at the same time (latch: start2 < end1)', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const scheduler = new ParallelScheduler();
    const world = latchWorld(gates, started, { scheduler });
    const running = runOrchestrateCommand(
      { prompt: 'do it', agents: ['a1', 'a2'], session: 'sess-1', yes: true },
      world.deps,
    );
    await vi.waitFor(() => expect(started).toEqual(['a1', 'a2']));
    // Both are blocked inside runWorker and the admission layer holds both
    // slots: the second start happened before the first end.
    expect(scheduler.runningCount()).toBe(2);
    expect(scheduler.runningIds().sort()).toEqual(['a1', 'a2']);
    gates.get('a1')?.resolve();
    gates.get('a2')?.resolve();
    expect(await running).toBe(0);
    expect(world.merged).toEqual(['a1', 'a2']);
  });

  it('merges in agent order even when a later worker settles first', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const world = latchWorld(gates, started);
    const running = runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2', 'a3'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    await vi.waitFor(() => expect(started).toEqual(['a1', 'a2', 'a3']));
    // Settle out of order: a3, then a1, then a2.
    gates.get('a3')?.resolve();
    gates.get('a1')?.resolve();
    gates.get('a2')?.resolve();
    expect(await running).toBe(0);
    expect(world.merged).toEqual(['a1', 'a2', 'a3']);
    expect(lastJsonLine(world.lines).mergeOrder).toEqual(['a1', 'a2', 'a3']);
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.merged).toEqual(['a1', 'a2', 'a3']);
  });

  it('fail-fast: a failing worker stops the run and cancels the in-flight sibling', async () => {
    const cancelled: string[] = [];
    const gate = deferred();
    const world = makeWorld({
      scheduler: new ParallelScheduler(),
      cancelWorker: (agentId: string) => {
        cancelled.push(agentId);
        gate.resolve();
      },
      runWorker: (agentId: string) =>
        agentId === 'a1'
          ? Promise.reject(
              Object.assign(new Error('boom'), { code: 'worker_failed' }),
            )
          : gate.promise.then(() => hunksFor(agentId)),
    });
    const code = await runOrchestrateCommand(
      { prompt: 'do it', agents: ['a1', 'a2'], session: 'sess-1', yes: true },
      world.deps,
    );
    expect(code).toBe(1);
    // The sibling was still running when a1 failed: it is cancelled, never
    // left spending tokens after the run decided to stop.
    expect(cancelled).toEqual(['a2']);
    expect(world.merged).toEqual([]);
  });

  it('a kill mid-run leaves only unmerged workers for --resume', async () => {
    const ran: string[] = [];
    const first = makeWorld({
      runWorker: (agentId: string) => {
        ran.push(agentId);
        return hunksFor(agentId);
      },
      mergeBranch: (agentId: string) => {
        if (agentId === 'a2') throw new Error('KILLED');
      },
    });
    const code1 = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2', 'a3'],
        session: 'sess-1',
        yes: true,
      },
      first.deps,
    );
    expect(code1).toBe(1);
    // All three ran; the kill hit the merge phase (a1 merged, a2 threw), so
    // the state keeps every unmerged worker for the retry.
    expect(ran).toEqual(['a1', 'a2', 'a3']);
    const killed = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(killed.merged).toEqual(['a1']);
    expect(killed.pending).toEqual(['a2', 'a3']);

    // Resume re-runs the unmerged pair only; a1 never re-runs or re-merges.
    const resumed: string[] = [];
    const second = makeWorld({
      loadState: () => structuredClone(killed),
      runWorker: (agentId: string) => {
        resumed.push(agentId);
        return hunksFor(agentId);
      },
    });
    expect(
      await runOrchestrateCommand(
        { resume: true, session: 'sess-1', yes: true },
        second.deps,
      ),
    ).toBe(0);
    expect(resumed).toEqual(['a2', 'a3']);
    expect(second.merged).toEqual(['a2', 'a3']);
  });
});

describe('orchestrate queue expiry and never-wakeable queues (issue #206 review)', () => {
  it('refuses a queued worker the admission layer expired, by name', async () => {
    // The scheduler's own bound elapses while the only slot is busy. Its
    // sweep drops the entry and returns it only from `sweepPending` — the run
    // must notice (reconcileQueue), not fall through to "can never admit".
    let now = 1_000;
    const scheduler = new ParallelScheduler(
      { maxPendingMs: 30 },
      { clock: () => now, sessionOverride: 1 },
    );
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const world = latchWorld(gates, started, { scheduler });
    const running = runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    await vi.waitFor(() => expect(started).toEqual(['a1']));
    expect(scheduler.queuedCount()).toBe(1);

    now += 10_000;
    gates.get('a1')?.resolve();

    expect(await running).toBe(1);
    // Nothing merged (the run stopped on the expiry) and the denial names the
    // worker and the bound — never a silent disappearance.
    expect(world.merged).toEqual([]);
    const text = world.lines.join('\n');
    expect(text).toMatch(/a2/);
    expect(text).toMatch(/queued past the admission layer's 30ms bound/);
    expect(text).toContain('spawn_denied');
  });

  it('refuses a queue head no release can wake, by name', async () => {
    // The head is blocked by a provider rate window that the settled worker
    // cannot free: nothing is in flight, so no release will ever come. The
    // provider comes from each worker's model pin (a role document), which is
    // also what makes the scheduler stamp the window.
    const scheduler = new ParallelScheduler({
      providerCaps: { prov: { maxPerWindow: 1, windowMs: 60_000 } },
    });
    const world = makeWorld({
      scheduler,
      loadWorkerRoles: (agents) => ({
        assignments: agents.map((agentId) => ({
          agentId,
          role: 'worker',
          promptText: '',
          tools: [],
          modelRef: 'prov/m1',
        })),
        refused: [],
      }),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1', 'a2'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.merged).toEqual([]);
    const text = world.lines.join('\n');
    expect(text).toMatch(/a2/);
    expect(text).toMatch(/can never admit this spawn/);
  });
});
