// The run timeline (EPIC N, issue #464; docs/ui 04-B): `kubic orchestrate`
// reports each phase transition through `onPhase` — plan → implement →
// review → merge → verify, a phase the run has no step for reported
// skipped, and whatever is running when the run fails reported failed.
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
} from './orchestrate-cli.js';
import {
  runOrchestrateCommand,
  WORKER_TASK_TITLE_MAX,
  workerTaskOf,
  workerTaskTitle,
} from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';

function world(overrides: Partial<OrchestrateCommandDeps> = {}) {
  const phases: string[] = [];
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  const deps: OrchestrateCommandDeps = {
    out: () => undefined,
    err: () => undefined,
    now: () => 1700000000000,
    onPhase: (event) => phases.push(`${event.phase}:${event.state}`),
    isGitRepo: () => true,
    ensureWorktree: (agentId: string): OrchestrateWorktree => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: () => hunks,
    mergeBranch: () => undefined,
    reapWorker: () => undefined,
    requestApproval: () => true,
    saveState: () => undefined,
    ...overrides,
  };
  return { deps, phases };
}

const RUN = {
  prompt: 'do it',
  agents: ['alpha', 'beta'],
  session: 'sess-464',
  yes: true,
};

describe('orchestrate run phases (issue #464)', () => {
  it('reports a template run from plan to verify, skipping what it has no step for', async () => {
    const { deps, phases } = world();
    expect(await runOrchestrateCommand(RUN, deps)).toBe(0);
    expect(phases).toEqual([
      'plan:running',
      'plan:done',
      'implement:running',
      'implement:done',
      'review:skipped',
      'merge:running',
      'merge:done',
      'verify:skipped',
    ]);
  });

  it('fails the phase a failing worker stops, and reports nothing past it', async () => {
    const { deps, phases } = world({
      runWorker: () => {
        throw new Error('boom');
      },
    });
    expect(await runOrchestrateCommand(RUN, deps)).not.toBe(0);
    expect(phases).toEqual([
      'plan:running',
      'plan:done',
      'implement:running',
      'implement:failed',
    ]);
  });

  it('fails the plan when the run refuses before any worker', async () => {
    const { deps, phases } = world({ isGitRepo: () => false });
    expect(await runOrchestrateCommand(RUN, deps)).not.toBe(0);
    expect(phases).toEqual(['plan:running', 'plan:failed']);
  });
});

describe('planned workers (issue #465)', () => {
  it('names the workers a run is about to start, with their task', async () => {
    const planned: unknown[] = [];
    const { deps } = world({ onPlanned: (workers) => planned.push(workers) });
    expect(await runOrchestrateCommand(RUN, deps)).toBe(0);
    expect(planned).toEqual([
      [
        { agentId: 'alpha', task: 'do it' },
        { agentId: 'beta', task: 'do it' },
      ],
    ]);
  });
});

describe('worker task titles (issue #464)', () => {
  it('hands every template worker the objective as its title, bounded', async () => {
    const tasks: Array<string | undefined> = [];
    const objective = `Fix the cart total\n\nthen ${'x'.repeat(100)}`;
    const { deps } = world({
      runWorker: (_agent, _worktree, _prompt, info) => {
        tasks.push(info?.task);
        return [];
      },
    });
    expect(
      await runOrchestrateCommand({ ...RUN, prompt: objective }, deps),
    ).toBe(0);
    expect(tasks).toEqual(['Fix the cart total', 'Fix the cart total']);
  });

  it('takes the first non-empty line, whitespace collapsed, at most 60 columns', () => {
    expect(workerTaskTitle('\n   Ship   the\tthing  \nmore')).toBe(
      'Ship the thing',
    );
    const long = workerTaskTitle('y'.repeat(200));
    expect(long).toHaveLength(WORKER_TASK_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(workerTaskTitle('  \n ')).toBe('');
  });

  it("reads a lane mint's own task from its plan step, ignoring a malformed one", () => {
    const state = {
      prompt: 'the objective',
      plan: [
        { agentId: 'worker-1', task: 'do alpha' },
        { agentId: 'worker-2', task: 42 },
        null,
      ],
    };
    expect(workerTaskOf(state, 'worker-1')).toBe('do alpha');
    expect(workerTaskOf(state, 'worker-2')).toBe('the objective');
    expect(workerTaskOf(state, 'nobody')).toBe('the objective');
  });
});
