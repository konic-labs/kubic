// Parallel surfacing on the live orchestrate path (issue #106; §49.1, §50).
// RED first: the run consults the ParallelScheduler per spawn but its
// running/queued counts never reached the operator, and no parallel event was
// ever built. These tests drive the REAL `runOrchestrateCommand` against the
// REAL `ParallelScheduler` — the numbers asserted are measured from the run,
// never assumed. The shipped spawn loop is strictly sequential (F2 in
// docs/architecture/orchestrator.md), so a queued outcome is only reachable
// when a slot is already occupied; the second test occupies it with the same
// real scheduler rather than faking the admission layer.
import { describe, expect, it } from 'vitest';
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
    // Measured, not assumed: the loop admits one worker at a time and
    // releases its slot before the next request, so six agents against the
    // default cap of four reach a running high-water of 1 and never queue.
    expect(lastJsonLine(world.lines).parallel).toEqual({
      running: 1,
      queued: 0,
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
    expect(world.lines).toContain('parallel: running 1 queued 0 cap 4');
    // The §49.1 agent-tree line the counts belong to.
    expect(world.lines).toContain('tree: sess-1 parallel 1/4');
  });

  it('emits one parallel trajectory event per queued spawn', async () => {
    const events: ParallelTrajectoryEvent[] = [];
    // A REAL scheduler whose only slot is already taken: the run's first
    // spawn is then genuinely queued (position 1) by the admission layer.
    const scheduler = new ParallelScheduler({ maxConcurrency: 1 });
    scheduler.requestSpawn(
      {
        agentId: 'squatter',
        sessionId: 'sess-1',
        worktree: '/repo/.kubic/wt/squatter',
      },
      'autonomous',
    );
    const world = makeWorld({
      scheduler,
      trajectoryEvent: (event) => {
        events.push(event);
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['a1'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'parallel',
      sessionId: 'sess-1',
      running: 1,
      queued: 1,
      maxConcurrency: 1,
    });
    // The queue is reported, never a gate: the sequential loop still spawns
    // and merges the worker (the F2 finding, re-measured here).
    expect(world.merged).toEqual(['a1']);
    expect(lastJsonLine(world.lines).parallel).toEqual({
      running: 1,
      queued: 1,
      maxConcurrency: 1,
    });
    // The same snapshot on the text surface (a second run, no --json, so the
    // human lines are emitted at all): counts plus the §49.1 tree line. Its
    // own scheduler — the first one still holds 'a1' queued.
    const textScheduler = new ParallelScheduler({ maxConcurrency: 1 });
    textScheduler.requestSpawn(
      {
        agentId: 'squatter',
        sessionId: 'sess-1',
        worktree: '/repo/.kubic/wt/squatter',
      },
      'autonomous',
    );
    const text = makeWorld({ scheduler: textScheduler });
    expect(
      await runOrchestrateCommand(
        { prompt: 'do it', agents: ['a1'], session: 'sess-1', yes: true },
        text.deps,
      ),
    ).toBe(0);
    expect(text.lines).toContain('parallel: running 1 queued 1 cap 1');
    expect(text.lines).toContain('tree: sess-1 parallel 1/1 (queued 1)');
  });
});
