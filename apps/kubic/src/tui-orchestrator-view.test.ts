// Issue #342 (§18, §16.5): the orchestrator view's feed. The TUI drive wraps
// the run's runWorker so each worker reports its start (role, worktree,
// model, generation) and its end (result status and spend), and the app
// renders those facts as nodes under the manager root on the next frame.
import { describe, expect, it } from 'vitest';
import type { OrchestrateCommandDeps } from '../../../packages/host/src/orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from '../../../packages/host/src/orchestrator/approvals/request.js';
import {
  type OrchestratorProjectionEvent,
  PresentationProjector,
} from '../../../packages/host/src/presentation/projector.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import {
  observeAsks,
  observeMergeAsks,
  observeWorkers,
} from './tui-orchestrator.js';

function depsWith(
  runWorker: OrchestrateCommandDeps['runWorker'],
): OrchestrateCommandDeps {
  return { runWorker } as unknown as OrchestrateCommandDeps;
}

const worktree = {
  path: '/repo/.kubic/wt/s-o1/alpha',
  branch: 'kubic/s-o1/alpha',
};

describe('observeWorkers (issue #342)', () => {
  it('reports start with role/worktree/model/generation and end with status and spend', async () => {
    const events: OrchestratorProjectionEvent[] = [];
    const deps = observeWorkers(
      depsWith(async () => ({
        hunks: [],
        result: {
          status: 'completed',
          summary: 'done',
          filesChanged: [],
          provenance: {} as never,
          metrics: {
            inputTokens: 1200,
            outputTokens: 300,
            cachedTokens: 0,
            toolCalls: 2,
            latencyMs: 1,
            wallMs: 2,
            costUsd: 0.0123,
          },
        },
      })),
      (event) => events.push(event),
    );
    await deps.runWorker('alpha', worktree, 'step 1', {
      sessionId: 's-o1',
      workerSessionId: 'w1',
      role: 'implementer',
      modelRef: 'faux/faux-1',
    });
    await deps.runWorker('alpha', worktree, 'step 1 again', {
      sessionId: 's-o1',
      workerSessionId: 'w2',
    });
    expect(events[0]).toEqual({
      type: 'worker-start',
      workerId: 'alpha',
      status: 'running',
      generation: 1,
      workspace: worktree.path,
      role: 'implementer',
      model: 'faux/faux-1',
    });
    expect(events[1]).toEqual({
      type: 'worker-update',
      workerId: 'alpha',
      status: 'completed',
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.0123,
      diffStat: { files: 0, added: 0, removed: 0 },
    });
    expect(events[2]).toMatchObject({ type: 'worker-start', generation: 2 });
  });

  it('a worker that throws is reported failed and the error still propagates', async () => {
    const events: OrchestratorProjectionEvent[] = [];
    const deps = observeWorkers(
      depsWith(async () => {
        throw new Error('spawn exploded');
      }),
      (event) => events.push(event),
    );
    await expect(deps.runWorker('beta', worktree, 'x')).rejects.toThrow(
      'spawn exploded',
    );
    expect(events.at(-1)).toEqual({
      type: 'worker-update',
      workerId: 'beta',
      status: 'failed',
    });
  });
});

describe('observeWorkers activity (issue #464)', () => {
  it('reports the task, the batched tool facts and the diff stat', async () => {
    const events: OrchestratorProjectionEvent[] = [];
    let tick: (() => void) | undefined;
    const deps = observeWorkers(
      depsWith(async (_agent, _worktree, _prompt, info) => {
        const fact = (id: string, state: 'running' | 'done') => ({
          id,
          tool: 'read',
          target: `${id}.ts`,
          state,
          at: 1,
        });
        info?.onActivity?.(fact('c1', 'running'));
        info?.onActivity?.(fact('c1', 'done'));
        info?.onActivity?.(fact('c2', 'running'));
        tick?.();
        info?.onActivity?.(fact('c2', 'done'));
        return {
          hunks: [
            {
              path: 'src/cart.js',
              hunk: '--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\n',
            },
            { path: 'logo.png', hunk: 'Binary files differ\n' },
          ],
        };
      }),
      (event) => events.push(event),
      {
        batch: {
          setTimer: (run) => {
            tick = run;
            return 1;
          },
          clearTimer: () => {
            tick = undefined;
          },
        },
      },
    );
    await deps.runWorker('alpha', worktree, 'step 1', {
      sessionId: 's-o1',
      workerSessionId: 'w1',
      task: 'Fix the cart total',
    });
    expect(events[0]).toMatchObject({
      type: 'worker-start',
      task: 'Fix the cart total',
    });
    const batches = events
      .filter((event) => event.type === 'worker-update' && 'facts' in event)
      .map((event) =>
        'facts' in event
          ? (event.facts ?? []).map((fact) => `${fact.id}:${fact.state}`)
          : [],
      );
    // The first fact goes out at once, the rest per interval, the tail
    // flushed before the end.
    expect(batches).toEqual([
      ['c1:running'],
      ['c1:done', 'c2:running'],
      ['c2:done'],
    ]);
    expect(events.at(-1)).toEqual({
      type: 'worker-update',
      workerId: 'alpha',
      status: 'completed',
      diffStat: { files: 2, added: 2, removed: 1 },
    });
  });

  it('forwards the run phases as run-phase events', () => {
    const events: OrchestratorProjectionEvent[] = [];
    const seen: string[] = [];
    const deps = observeWorkers(
      {
        ...depsWith(async () => []),
        onPhase: (event) => seen.push(event.phase),
      },
      (event) => events.push(event),
    );
    deps.onPhase?.({ phase: 'plan', state: 'running', at: 5 });
    expect(seen).toEqual(['plan']);
    expect(events).toEqual([
      { type: 'run-phase', phase: 'plan', state: 'running', at: 5 },
    ]);
  });

  it('marks a worker awaiting while its ask or its merge is open', async () => {
    const events: OrchestratorProjectionEvent[] = [];
    let answer: (() => void) | undefined;
    const seat = observeAsks(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ approved: true, by: 'user' });
        }),
      (event) => events.push(event),
    );
    const pending = seat({
      key: 'k1',
      agentId: 'alpha',
      summary: 'bash rm -rf dist',
    } as OrchestratorApprovalRequest);
    expect(events).toEqual([
      {
        type: 'worker-update',
        workerId: 'alpha',
        awaiting: { approvalKey: 'k1', summary: 'bash rm -rf dist' },
      },
    ]);
    answer?.();
    await pending;
    expect(events.at(-1)).toEqual({
      type: 'worker-update',
      workerId: 'alpha',
      awaiting: null,
    });
    const merge = observeMergeAsks(
      async () => ({ verdict: 'deny' }),
      (event) => events.push(event),
    );
    await merge({ agentId: 'beta', branch: 'kubic/s/beta' } as never);
    expect(events.slice(-2)).toEqual([
      {
        type: 'worker-update',
        workerId: 'beta',
        awaiting: {
          approvalKey: 'merge:kubic/s/beta',
          summary: 'merge kubic/s/beta',
        },
      },
      { type: 'worker-update', workerId: 'beta', awaiting: null },
    ]);
  });
});

describe('the orchestrator view in the app (issue #342)', () => {
  it('renders the workers as nodes and a status change on the next frame', () => {
    const app = createTuiApp({
      sessionId: 'sess',
      model: 'faux/m',
      mode: 'orchestrator',
      approvalsSkipped: false,
    });
    const projector = new PresentationProjector({
      sessionId: 'sess',
      mode: 'orchestrator',
      approvalsSkipped: false,
    } as never);
    projector.applyWorker({
      type: 'worker-start',
      workerId: 'alpha',
      role: 'implementer',
      status: 'running',
      generation: 1,
      workspace: worktree.path,
    });
    app.applyPresentation(projector.state());
    expect(app.render(120).join('\n')).toContain(
      '● alpha  implementer  running  g1  wt:alpha',
    );
    projector.applyWorker({
      type: 'worker-update',
      workerId: 'alpha',
      status: 'failed',
    });
    app.applyPresentation(projector.state());
    expect(app.render(120).join('\n')).toContain(
      '✗ alpha  implementer  failed  g1',
    );
    // No overlay host outside a live screen: the inspector cannot open, and
    // an unknown worker is refused either way.
    expect(app.inspectWorker('nobody')).toBe(false);
  });
});
