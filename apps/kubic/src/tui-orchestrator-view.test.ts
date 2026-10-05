// Issue #342 (§18, §16.5): the orchestrator view's feed. The TUI drive wraps
// the run's runWorker so each worker reports its start (role, worktree,
// model, generation) and its end (result status and spend), and the app
// renders those facts as nodes under the manager root on the next frame.
import { describe, expect, it } from 'vitest';
import type { OrchestrateCommandDeps } from '../../../packages/host/src/orchestrate-cli.js';
import {
  PresentationProjector,
  type WorkerProjectionEvent,
} from '../../../packages/host/src/presentation/projector.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import { observeWorkers } from './tui-orchestrator.js';

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
    const events: WorkerProjectionEvent[] = [];
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
    });
    expect(events[2]).toMatchObject({ type: 'worker-start', generation: 2 });
  });

  it('a worker that throws is reported failed and the error still propagates', async () => {
    const events: WorkerProjectionEvent[] = [];
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
