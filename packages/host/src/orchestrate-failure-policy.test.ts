// Worker-failure policy on the live orchestrate path (issue #169; §9.2, §13).
//
// RED first: one denied, budget-stopped or crashed worker ended the whole
// run. Every worker after the failing one never launched, nothing merged, and
// `--resume` was the only recovery. `--on-failure continue` keeps the run
// going for worker-level failures, merges the workers that succeeded, reports
// every failed one with its own §78 code, and exits the partial-failure code
// (7). `stop` stays the default and the shipped behaviour.
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from './orchestrate-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  merged: string[];
  saved: OrchestratorRunState[];
}

function hunksFor(agentId: string): MergedHunk[] {
  return [{ path: `${agentId}.txt`, hunk: `@@ -0,0 +1 @@ +${agentId}` }];
}

function makeWorld(overrides: Partial<OrchestrateCommandDeps> = {}): FakeWorld {
  const lines: string[] = [];
  const merged: string[] = [];
  const saved: OrchestratorRunState[] = [];
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
    runWorker: (agentId: string) => hunksFor(agentId),
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
  // The report and the diagnostics share the fake's line list; the envelope
  // is the last JSON document written to stdout.
  const json = lines.filter((line) => line.startsWith('{')).pop();
  if (json === undefined) throw new Error('no JSON envelope on the output');
  return JSON.parse(json) as Record<string, unknown>;
}

interface EnvelopeWorker {
  agentId: string;
  status?: string;
  error?: { details?: { code?: string } };
}

/** The three-worker run the acceptance criteria describe: #2 crashes. */
function crashingWorld(
  overrides: Partial<OrchestrateCommandDeps> = {},
): FakeWorld {
  return makeWorld({
    runWorker: (agentId: string) => {
      if (agentId === 'w2') {
        throw Object.assign(new Error('boom'), { code: 'worker_failed' });
      }
      return hunksFor(agentId);
    },
    ...overrides,
  });
}

describe('orchestrate --on-failure continue (issue #169, §9.2/§13)', () => {
  it('merges the survivors, names the failed worker with its code, and exits partial', async () => {
    const world = crashingWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['w1', 'w2', 'w3'],
        session: 'sess-1',
        yes: true,
        json: true,
        onFailure: 'continue',
      },
      world.deps,
    );
    expect(code).toBe(7);
    // #1 and #3 merged; #2 never did.
    expect(world.merged).toEqual(['w1', 'w3']);
    const envelope = lastJsonLine(world.lines);
    expect(envelope).toMatchObject({
      ok: false,
      exitCode: 7,
      status: 'partial',
      mergeOrder: ['w1', 'w3'],
    });
    expect(envelope.error).toMatchObject({
      code: 'partial_failure',
      kind: 'partial',
    });
    expect(String((envelope.error as { message: string }).message)).toContain(
      'w2',
    );
    // Every worker is listed, and the failed one carries its own code.
    const workers = envelope.workers as EnvelopeWorker[];
    expect(workers.map((worker) => worker.agentId)).toEqual(['w1', 'w2', 'w3']);
    expect(workers[1]).toMatchObject({
      status: 'failed',
      error: { details: { code: 'worker_failed' } },
    });
    // The survivors are not marked failed (this fake reports no §68 result of
    // its own, so the absence of an error is what says they succeeded).
    expect(workers[0]?.status).not.toBe('failed');
    expect(workers[2]?.status).not.toBe('failed');
    expect(workers[0]?.error).toBeUndefined();
    expect(workers[2]?.error).toBeUndefined();
    // The failed worker was never merged and stays pending: `--resume`
    // retries exactly it, never the workers that already landed.
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.merged).toEqual(['w1', 'w3']);
    expect(saved.pending).toEqual(['w2']);
  });

  it('--on-failure stop (the default) keeps the all-or-nothing behaviour', async () => {
    const world = crashingWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['w1', 'w2', 'w3'],
        session: 'sess-1',
        yes: true,
        json: true,
        onFailure: 'stop',
      },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.merged).toEqual([]);
    const envelope = lastJsonLine(world.lines);
    expect(envelope.error).toMatchObject({ code: 'worker_failed' });
    // Nothing was merged, so every worker is pending for the retry.
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.merged).toEqual([]);
    expect(saved.pending).toEqual(['w1', 'w2', 'w3']);
  });

  it('--resume re-runs only the failed worker and settles the session', async () => {
    const first = crashingWorld();
    expect(
      await runOrchestrateCommand(
        {
          prompt: 'do it',
          agents: ['w1', 'w2', 'w3'],
          session: 'sess-1',
          yes: true,
          onFailure: 'continue',
        },
        first.deps,
      ),
    ).toBe(7);
    const stored = first.saved[first.saved.length - 1] as OrchestratorRunState;

    const reran: string[] = [];
    const second = makeWorld({
      loadState: () => structuredClone(stored),
      runWorker: (agentId: string) => {
        reran.push(agentId);
        return hunksFor(agentId);
      },
    });
    expect(
      await runOrchestrateCommand(
        { resume: true, session: 'sess-1', yes: true },
        second.deps,
      ),
    ).toBe(0);
    // Only the failed worker ran again; the merged pair was never re-run.
    expect(reran).toEqual(['w2']);
    expect(second.merged).toEqual(['w2']);
    const done = second.saved[second.saved.length - 1] as OrchestratorRunState;
    expect(done.merged).toEqual(['w1', 'w3', 'w2']);
    expect(done.pending).toEqual([]);
  });

  it('an approval terminus still stops the run even under continue', async () => {
    const world = makeWorld({
      runWorker: (agentId: string) => {
        if (agentId === 'w2') {
          throw Object.assign(new Error('user denied it'), {
            approval: { code: 'approval_denied', exitCode: 4 },
          });
        }
        return hunksFor(agentId);
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['w1', 'w2', 'w3'],
        session: 'sess-1',
        yes: true,
        onFailure: 'continue',
      },
      world.deps,
    );
    // A denial is the user's decision for the whole run: exit 4, nothing
    // merged (the survivors are preserved for --resume).
    expect(code).toBe(4);
    expect(world.merged).toEqual([]);
  });

  it('a budget-exhausted worker is a worker-level terminus: the run continues', async () => {
    const world = makeWorld({
      runWorker: (agentId: string) => {
        if (agentId === 'w2') {
          throw Object.assign(new Error('budget exhausted'), {
            approval: { code: 'budget_exhausted', exitCode: 3 },
          });
        }
        return hunksFor(agentId);
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['w1', 'w2', 'w3'],
        session: 'sess-1',
        yes: true,
        onFailure: 'continue',
      },
      world.deps,
    );
    expect(code).toBe(7);
    expect(world.merged).toEqual(['w1', 'w3']);
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.pending).toEqual(['w2']);
  });
});

describe('orchestrate --on-failure policy and unwakeable queues (issue #169 review)', () => {
  it('re-applies the stored policy on --resume; an explicit flag still wins', async () => {
    const first = crashingWorld();
    expect(
      await runOrchestrateCommand(
        {
          prompt: 'do it',
          agents: ['w1', 'w2', 'w3'],
          session: 'sess-1',
          yes: true,
          onFailure: 'continue',
        },
        first.deps,
      ),
    ).toBe(7);
    const stored = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(stored.onFailure).toBe('continue');
    expect(stored.pending).toEqual(['w2']);

    // Resume WITHOUT the flag: the stored policy is re-applied, so the retried
    // worker's second crash is a partial terminus (7), not all-or-nothing (1).
    const resumed = crashingWorld({ loadState: () => structuredClone(stored) });
    expect(
      await runOrchestrateCommand(
        { resume: true, session: 'sess-1', yes: true },
        resumed.deps,
      ),
    ).toBe(7);

    // An explicit `stop` on the retry wins over the stored policy.
    const stopped = crashingWorld({ loadState: () => structuredClone(stored) });
    expect(
      await runOrchestrateCommand(
        { resume: true, session: 'sess-1', yes: true, onFailure: 'stop' },
        stopped.deps,
      ),
    ).toBe(1);
  });

  it('does not hang when a queued worker can never be admitted', async () => {
    // The head is blocked by a provider rate window no release can free, so
    // the run must refuse it and finish: `continue` used to re-find the same
    // stuck agent forever (the guard was not idempotent).
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
        onFailure: 'continue',
      },
      world.deps,
    );
    expect(code).toBe(7);
    expect(world.merged).toEqual(['a1']);
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.pending).toEqual(['a2']);
  });
});
