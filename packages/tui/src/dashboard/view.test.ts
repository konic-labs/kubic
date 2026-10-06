// The orchestrator dashboard's view state and keys (issue #465): selection
// that skips group labels, the filter, the view toggle and the intents the
// worker keys produce.
import { describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  WorkerSummary,
} from '../../../core/src/presentation.js';
import { DashboardView, runTaskTitle } from './view.js';

function state(workers: readonly WorkerSummary[]): KubicPresentationState {
  return {
    session: {
      sessionId: 's',
      mode: 'orchestrator',
      approvalsSkipped: false,
      runPhases: [{ phase: 'plan', state: 'done', at: 1, startedAt: 0 }],
    },
    agents: new Map(),
    lanes: new Map(),
    workers: new Map(workers.map((worker) => [worker.workerId, worker])),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

const WORKERS: WorkerSummary[] = [
  { workerId: 'worker-1', status: 'completed', task: 'cart total' },
  {
    workerId: 'worker-2',
    status: 'running',
    task: 'format tests',
    awaiting: { approvalKey: 'k', summary: 'bash rm -rf dist' },
  },
  { workerId: 'worker-3', status: 'running', task: 'docs' },
];

function setup() {
  const view = new DashboardView();
  view.startRun('  \n Fix the cart total\nand more');
  const press = (data: string, keyId?: string, action?: string) =>
    view.handleKey(
      {
        data,
        ...(keyId === undefined ? {} : { keyId }),
        ...(action === undefined ? {} : { action }),
      },
      view.model(state(WORKERS), { now: 10 }),
    );
  return { view, press };
}

describe('the dashboard view (issue #465)', () => {
  it('a new run shows the dashboard under its objective', () => {
    const { view } = setup();
    expect(view.view).toBe('dashboard');
    expect(view.runTask).toBe('Fix the cart total');
    expect(view.model(state(WORKERS), { now: 10 }).task).toBe(
      'Fix the cart total',
    );
    expect(runTaskTitle('\n\n')).toBe('');
  });

  it('moves the selection by worker, from the one waiting on you', () => {
    const { view, press } = setup();
    expect(press('\u001b[B', 'down')).toEqual({ kind: 'render' });
    // awaiting (worker-2) → working (worker-3): the WORKING label is skipped.
    expect(view.selected).toBe('worker-3');
    press('j');
    expect(view.selected).toBe('worker-1');
    press('j');
    expect(view.selected).toBe('worker-1');
    press('k');
    press('\u001b[A', 'up');
    expect(view.selected).toBe('worker-2');
  });

  it('turns the worker keys into intents on the selection', () => {
    const { press } = setup();
    expect(press('\r', 'enter')).toEqual({
      kind: 'open',
      workerId: 'worker-2',
    });
    expect(press('x')).toEqual({ kind: 'stop', workerId: 'worker-2' });
    // A running worker did not fail: nothing to retry.
    expect(press('r')).toEqual({
      kind: 'hint',
      text: 'retry: worker-2 did not fail',
    });
    expect(press('\u000f', 'ctrl+o', 'panel.diff')).toEqual({
      kind: 'diff',
      workerId: 'worker-2',
    });
    expect(press('a')).toEqual({ kind: 'answer' });
  });

  it('filters as you type after `/`, keeps it on enter, clears it on esc', () => {
    const { view, press } = setup();
    press('/');
    expect(view.filtering).toBe(true);
    for (const ch of 'docs') press(ch);
    expect(view.filter).toBe('docs');
    press('\u007f', 'backspace');
    press('s');
    press('\r', 'enter');
    expect(view.filtering).toBe(false);
    expect(
      view
        .model(state(WORKERS), { now: 10 })
        .workers.map((row) => row.worker.workerId),
    ).toEqual(['worker-3']);
    // The selection follows what is shown.
    expect(press('\r', 'enter')).toEqual({
      kind: 'open',
      workerId: 'worker-3',
    });
    press('\u001b', 'escape', 'app.cancel');
    expect(view.filter).toBe('');
  });

  it('tab goes to the manager transcript; other global keys pass', () => {
    const { view, press } = setup();
    expect(press('\u0010', 'ctrl+p', 'app.palette')).toEqual({ kind: 'pass' });
    expect(press('q')).toEqual({
      kind: 'hint',
      text: 'tab: talk to the manager',
    });
    press('\t', 'tab');
    expect(view.view).toBe('manager');
  });

  it('stops only a live worker and retries only a failed one', () => {
    const view = new DashboardView();
    view.startRun('go');
    const workers: WorkerSummary[] = [
      { workerId: 'done-1', status: 'completed' },
      { workerId: 'bad-1', status: 'failed' },
    ];
    const model = view.model(state(workers), { now: 1 });
    view.selected = 'done-1';
    expect(view.handleKey({ data: 'x' }, model)).toEqual({
      kind: 'hint',
      text: 'stop: done-1 is not running',
    });
    view.selected = 'bad-1';
    expect(view.handleKey({ data: 'r' }, model)).toEqual({
      kind: 'retry',
      workerId: 'bad-1',
    });
  });

  it('names a worker key with nothing selected', () => {
    const view = new DashboardView();
    view.startRun('go');
    expect(
      view.handleKey({ data: 'x' }, view.model(state([]), { now: 1 })),
    ).toEqual({ kind: 'hint', text: 'no worker selected' });
  });
});
