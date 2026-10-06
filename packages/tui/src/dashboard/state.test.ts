// The orchestrator dashboard's model (issue #465): grouping by what each
// worker needs, counts, elapsed time, usage, the filter and the selection —
// derived from the presentation state the projector folds.
import { describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  RunPhaseState,
  WorkerSummary,
} from '../../../core/src/presentation.js';
import {
  dashboardModel,
  defaultSelection,
  moveSelection,
  resolveSelection,
} from './state.js';

function presentation(
  workers: readonly WorkerSummary[],
  runPhases: readonly RunPhaseState[] = [],
): KubicPresentationState {
  return {
    session: {
      sessionId: 's',
      mode: 'orchestrator',
      approvalsSkipped: false,
      runPhases,
    },
    agents: new Map(),
    lanes: new Map(),
    workers: new Map(workers.map((worker) => [worker.workerId, worker])),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

const PHASES: RunPhaseState[] = [
  { phase: 'plan', state: 'done', at: 2_000, startedAt: 1_000 },
  { phase: 'implement', state: 'running', at: 2_000, startedAt: 2_000 },
];

const WORKERS: WorkerSummary[] = [
  {
    workerId: 'worker-1',
    role: 'implementer',
    task: 'task worker-1',
    status: 'completed',
    startedAt: 2_000,
    endedAt: 32_000,
    inputTokens: 10_000,
    outputTokens: 2_000,
    costUsd: 0.12,
    diffStat: { files: 2, added: 9, removed: 1 },
  },
  {
    workerId: 'worker-2',
    role: 'reviewer',
    task: 'task worker-2',
    status: 'running',
    startedAt: 3_000,
    awaiting: { approvalKey: 'k', summary: 'bash rm -rf dist' },
  },
  {
    workerId: 'worker-3',
    task: 'task worker-3',
    status: 'failed',
    startedAt: 3_000,
    endedAt: 5_000,
    costUsd: 0.01,
  },
  { workerId: 'worker-4', task: 'task worker-4', status: 'queued' },
];

const model = (
  input: { now?: number; filter?: string } = {},
  phases = PHASES,
) =>
  dashboardModel(presentation(WORKERS, phases), {
    now: input.now ?? 10_000,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
  });

describe('the dashboard model (issue #465)', () => {
  it('groups awaiting first, then working, done and queued, with counts', () => {
    const view = model();
    expect(view.workers.map((row) => [row.worker.workerId, row.group])).toEqual(
      [
        ['worker-2', 'awaiting'],
        ['worker-1', 'done'],
        ['worker-3', 'done'],
        ['worker-4', 'queued'],
      ],
    );
    expect(view.counts).toEqual({
      awaiting: 1,
      working: 0,
      done: 1,
      failed: 1,
      queued: 1,
    });
    expect(
      view.workers.find((row) => row.worker.workerId === 'worker-3')?.failed,
    ).toBe(true);
  });

  it('times each generation and the run, and sums the spend', () => {
    const view = model();
    expect(
      Object.fromEntries(
        view.workers.map((row) => [row.worker.workerId, row.elapsedMs]),
      ),
    ).toEqual({
      'worker-1': 30_000,
      'worker-2': 7_000,
      'worker-3': 2_000,
      'worker-4': undefined,
    });
    // From the plan's start, still running.
    expect(view.elapsedMs).toBe(9_000);
    expect(view.usage.tokens).toBe(12_000);
    expect(view.usage.costUsd).toBeCloseTo(0.13);
  });

  it('stops the run clock once every phase settled', () => {
    const settled: RunPhaseState[] = [
      { phase: 'plan', state: 'done', at: 2_000, startedAt: 1_000 },
      { phase: 'implement', state: 'done', at: 40_000, startedAt: 2_000 },
      { phase: 'verify', state: 'skipped', at: 41_000 },
    ];
    expect(model({ now: 99_000 }, settled).elapsedMs).toBe(40_000);
  });

  it('filters by id, role or task, keeping the counts whole', () => {
    const view = model({ filter: 'REVIEW' });
    expect(view.workers.map((row) => row.worker.workerId)).toEqual([
      'worker-2',
    ]);
    expect(view.total).toBe(4);
    expect(view.counts.queued).toBe(1);
    expect(
      model({ filter: 'task worker-4' }).workers.map(
        (row) => row.worker.workerId,
      ),
    ).toEqual(['worker-4']);
  });

  it('has no run before a phase is reported', () => {
    const view = dashboardModel(presentation([]), { now: 5 });
    expect(view.elapsedMs).toBeUndefined();
    expect(view.workers).toEqual([]);
    expect(defaultSelection(view)).toBeUndefined();
  });
});

describe('dashboard selection (issue #465)', () => {
  it('starts on the first worker waiting on you and moves by worker', () => {
    const view = model();
    expect(defaultSelection(view)).toBe('worker-2');
    expect(moveSelection(view, 'worker-2', 1)).toBe('worker-1');
    expect(moveSelection(view, 'worker-1', 2)).toBe('worker-4');
    expect(moveSelection(view, 'worker-4', 1)).toBe('worker-4');
    expect(moveSelection(view, 'worker-2', -1)).toBe('worker-2');
  });

  it('falls back to the default when the selection is filtered away', () => {
    const view = model({ filter: 'worker-4' });
    expect(resolveSelection(view, 'worker-2')).toBe('worker-4');
    expect(moveSelection(view, 'worker-2', 1)).toBe('worker-4');
  });
});
