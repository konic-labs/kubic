// The orchestrator dashboard in the app (EPIC N, issue #465; docs/ui 04-A,
// 04-B, 04-C, 04-E): an objective handed to the manager opens the dashboard
// in place of the tree, transcript, status line and editor; its keys select
// and act on workers; a worker's ask waits in AWAITING YOU until `a`; `tab`
// reaches the manager transcript and back.
import { describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  RunPhaseState,
  WorkerSummary,
} from '../../core/src/presentation.js';
import { createApprovalSurface } from './approval-surface.js';
import type { ApprovalOverlayTui } from './approval-view.js';
import { createTuiApp } from './tui-app.js';
import type { Component } from './tui-boundary.js';

const PHASES: RunPhaseState[] = [
  {
    phase: 'plan',
    state: 'done',
    at: Date.now() - 5_000,
    startedAt: Date.now() - 9_000,
  },
  {
    phase: 'implement',
    state: 'running',
    at: Date.now() - 5_000,
    startedAt: Date.now() - 5_000,
  },
];

const WORKERS: WorkerSummary[] = [
  {
    workerId: 'worker-1',
    role: 'implementer',
    task: 'cart clear()',
    status: 'running',
    startedAt: Date.now() - 4_000,
    workspace: '/repo/.kubic/wt/run/worker-1',
    toolCount: 3,
    activity: {
      id: 'c',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'running',
      at: 1,
    },
  },
  {
    workerId: 'worker-2',
    role: 'implementer',
    task: 'format tests',
    status: 'completed',
    startedAt: Date.now() - 4_000,
    endedAt: Date.now() - 1_000,
    diffStat: { files: 1, added: 4, removed: 0 },
  },
];

function presentation(
  workers: readonly WorkerSummary[],
): KubicPresentationState {
  return {
    session: {
      sessionId: 'sess-465',
      mode: 'orchestrator',
      approvalsSkipped: false,
      runPhases: PHASES,
    },
    agents: new Map(),
    lanes: new Map(),
    workers: new Map(workers.map((worker) => [worker.workerId, worker])),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

let clock = 0;

function setup(
  seed: {
    workerDiff?: (worker: {
      workerId: string;
      workspace: string;
    }) => Promise<string | undefined>;
  } = {},
) {
  // The real arming rule (#315) on a fake clock, so the re-arm on `a` is
  // observable.
  const surface = createApprovalSurface({
    armingMs: 400,
    quietMs: 600,
    now: () => clock,
    setTimer: () => () => {},
  });
  const app = createTuiApp({
    sessionId: 'sess-465',
    model: 'faux/m',
    mode: 'orchestrator',
    approvalsSkipped: false,
    approvalSurface: surface,
    ...seed,
  });
  const shown: Array<{ component: Component; hidden: boolean }> = [];
  const host: ApprovalOverlayTui = {
    terminal: { columns: 140, rows: 40 },
    showOverlay: (component) => {
      const entry = { component, hidden: false };
      shown.push(entry);
      return {
        unfocus: () => {},
        hide: () => {
          entry.hidden = true;
        },
      };
    },
  };
  app.attachApprovalOverlay(host);
  app.onSubmit(() => 'accepted');
  const submit = (text: string): void => {
    for (const ch of text) app.handleInput(ch);
    app.handleInput('\r');
  };
  const frame = (): string => app.render(140).join('\n');
  const overlay = (): string =>
    shown
      .filter((entry) => !entry.hidden)
      .map((entry) => entry.component.render(120).join('\n'))
      .join('\n');
  return { app, surface, submit, frame, overlay };
}

describe('the orchestrator dashboard in the app (issue #465)', () => {
  it('opens on an objective, in place of the transcript and editor', () => {
    const { app, submit, frame } = setup();
    expect(app.orchestratorView()).toBe('manager');
    submit('add cart clear() and format tests');
    expect(app.orchestratorView()).toBe('dashboard');
    app.applyPresentation(presentation(WORKERS));
    const text = frame();
    expect(text).toContain('[ORCHESTRATE]  add cart clear() and format tests');
    expect(text).toMatch(/RUN {2}✓ plan .* implement/);
    expect(text).toContain('WORKING');
    expect(text).toContain('worker-1  cart clear()');
    expect(text).toContain('edit src/cart.js · 3 tools');
    expect(text).toContain('+4 −0 · 1 file');
    expect(text).toContain('RUN BUDGET');
    expect(text).toContain('↑↓ select');
    expect(text).toContain('tab manager');
    // No editor box and no status line while the dashboard shows.
    expect(text).not.toContain('╭');
    expect(text).not.toContain('faux/m');
  });

  it('selects by worker and acts on the selection', () => {
    const { app, submit, frame } = setup();
    const actions: string[] = [];
    app.setWorkerActionHandler((action, workerId) => {
      actions.push(`${action}:${workerId}`);
      return `${action === 'stop' ? 'stopping' : 'retrying'} ${workerId}`;
    });
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    expect(frame()).toContain(`▌`);
    // worker-1 runs: it stops. worker-2 finished: it neither stops nor
    // retries, and the footer says why.
    app.handleInput('x');
    expect(frame()).toContain('stopping worker-1');
    app.handleInput('j');
    app.handleInput('x');
    expect(frame()).toContain('stop: worker-2 is not running');
    app.handleInput('r');
    expect(frame()).toContain('retry: worker-2 did not fail');
    expect(actions).toEqual(['stop:worker-1']);
  });

  it('opens the worker inspector on enter', () => {
    const { app, submit, overlay } = setup();
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    app.handleInput('\r');
    expect(overlay()).toContain('┌─ worker-1');
    expect(overlay()).toContain('task: cart clear()');
    expect(overlay()).toContain('latest tool: edit src/cart.js (running)');
  });

  it("shows the selected worker's diff on ^O", async () => {
    const asked: string[] = [];
    const { app, submit, overlay } = setup({
      workerDiff: async (worker) => {
        asked.push(`${worker.workerId}@${worker.workspace}`);
        return 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
      },
    });
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    app.handleInput('\u000f');
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['worker-1@/repo/.kubic/wt/run/worker-1']);
    expect(overlay()).toContain('diff worker-1');
    expect(overlay()).toContain('+new');
  });

  it('filters the workers after `/`', () => {
    const { app, submit, frame } = setup();
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    app.handleInput('/');
    for (const ch of 'format') app.handleInput(ch);
    const text = frame();
    expect(text).toContain('worker-2  format tests');
    expect(text).not.toContain('worker-1  cart clear()');
    expect(text).toContain('/format▏');
    app.handleInput('\u001b');
    expect(frame()).toContain('worker-1  cart clear()');
  });

  it('tab reaches the manager transcript and an empty editor tabs back', () => {
    const { app, submit, frame } = setup();
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    app.handleInput('\t');
    expect(app.orchestratorView()).toBe('manager');
    expect(frame()).toContain('tab dashboard');
    expect(frame()).not.toContain('RUN BUDGET');
    app.handleInput('\t');
    expect(app.orchestratorView()).toBe('dashboard');
  });

  it("keeps a worker's ask in AWAITING YOU until `a` opens the card", async () => {
    const { app, surface, submit, frame } = setup();
    submit('go');
    app.applyPresentation(
      presentation([
        {
          ...(WORKERS[0] as WorkerSummary),
          awaiting: {
            approvalKey: 'k1',
            summary: "worker 'worker-1': bash rm -rf dist",
          },
        },
        WORKERS[1] as WorkerSummary,
      ]),
    );
    clock = 0;
    const verdict = surface.ask({
      key: 'k1',
      capability: 'exec',
      toolName: 'bash',
      summary: "worker 'worker-1': bash rm -rf dist",
      command: 'rm -rf dist',
    });
    let text = frame();
    expect(text).toContain('AWAITING YOU');
    expect(text).toContain('◆ worker-1 is waiting on you · a answer');
    // Long after the ask arrived, the card is not on screen and takes no
    // keys: `d` (deny) does nothing.
    clock = 10_000;
    app.handleInput('d');
    expect(surface.isShowing()).toBe(true);
    app.handleInput('a');
    text = frame();
    expect(text).toContain('rm -rf dist');
    expect(text).toContain('allow once');
    // Right after `a` a second `a` cannot allow: the card armed anew…
    clock = 10_100;
    app.handleInput('a');
    expect(surface.isShowing()).toBe(true);
    // …and once the swallowed key's quiet period passed, `a` allows once.
    clock = 10_800;
    app.handleInput('a');
    await expect(verdict).resolves.toMatchObject({ approved: true });
    expect(app.orchestratorView()).toBe('dashboard');
    expect(frame()).toContain('RUN BUDGET');
  });

  it('arms a revealed card with the ordinary window, not the typing one', async () => {
    const { app, surface, submit } = setup();
    submit('go');
    app.applyPresentation(presentation(WORKERS));
    clock = 0;
    const verdict = surface.ask({
      key: 'k2',
      capability: 'exec',
      toolName: 'bash',
      summary: 'bash ls',
      command: 'ls',
    });
    clock = 5_000;
    app.handleInput('a');
    // 400 ms after the reveal the card is armed (the 600 ms typing window
    // would still be locked).
    clock = 5_450;
    app.handleInput('a');
    await expect(verdict).resolves.toMatchObject({ approved: true });
  });
});
