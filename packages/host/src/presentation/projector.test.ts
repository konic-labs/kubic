// §66's host-side projector (issue #333): folds the replicated event stream
// into a KubicPresentationState. Pure — no I/O, no harness.
import { describe, expect, it } from 'vitest';
import type { KubicLaneEvent } from '../../../worker/src/lane/events.js';
import { PresentationProjector } from './projector.js';

const SEED = {
  sessionId: 'sess-1',
  model: 'faux/faux-1',
  mode: 'solo' as const,
  approvalsSkipped: false,
  workspace: '/repo',
};

function usageRow(input: number, output: number, total: number) {
  return {
    model: 'faux-1',
    provider: 'faux',
    entryId: '7',
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    },
  };
}

describe('presentation projector (issue #333; §66)', () => {
  it('starts from the seed with one idle root lane', () => {
    const state = new PresentationProjector(SEED).state();
    expect(state.session).toEqual({
      sessionId: 'sess-1',
      model: 'faux/faux-1',
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(state.agents.get('root')).toEqual({
      agentId: 'root',
      role: 'root',
      status: 'idle',
      workspace: '/repo',
    });
    expect(state.lanes.get('sess-1')).toEqual({
      laneId: 'sess-1',
      agentId: 'root',
      status: 'idle',
      tools: [],
      queued: [],
      compacting: false,
    });
    expect(state.connection).toEqual({ status: 'connected' });
  });

  it('folds a fixture event sequence into the expected state', () => {
    const projector = new PresentationProjector(SEED);
    const events: KubicLaneEvent[] = [
      { type: 'run-start', inputs: [1 as never] },
      {
        type: 'tool-start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      },
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
      },
      {
        type: 'usage',
        row: usageRow(100, 20, 0.02) as never,
        entry: {} as never,
      },
      { type: 'retry', phase: 'start', attempt: 2, error: 'flaky' },
      { type: 'retry', phase: 'end', attempt: 2 },
      { type: 'compaction', phase: 'start', reason: 'auto' },
      { type: 'compaction', phase: 'end', reason: 'auto' },
      { type: 'run-end', inputs: [1 as never] },
    ];
    for (const event of events) projector.apply(event);
    const lane = projector.state().lanes.get('sess-1');
    expect(lane?.status).toBe('done');
    expect(lane?.tools).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'bash',
        status: 'done',
        isError: false,
        args: { command: 'pnpm test' },
        // The projector measures the call's duration (real clock here).
        durationMs: expect.any(Number),
      },
    ]);
    expect(lane?.compacting).toBe(false);
    expect(lane?.retrying).toBeUndefined();
    expect(projector.state().usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.02,
      requests: 1,
    });
    // Every fold bumps the counter, so a consumer can tell states apart.
    expect(projector.revision()).toBe(events.length);
  });

  it('replaces the lane from a snapshot and folds the inbox', () => {
    const projector = new PresentationProjector(SEED);
    projector.setQueuedText(new Map([['sub-1', 'second prompt']]));
    projector.apply({
      type: 'snapshot',
      entries: [],
      run: [9 as never],
      tools: [
        {
          toolCallId: 'c9',
          toolName: 'read',
          status: 'done',
          isError: true,
        },
      ],
      compactions: [
        { taskId: 't1' as never, reason: 'auto', blocking: false, attempt: 1 },
      ],
      usage: {
        models: {
          'faux/faux-1': {
            input: 5,
            output: 6,
            cacheRead: 7,
            cacheWrite: 8,
            totalTokens: 26,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.5,
            },
          },
        },
        tools: {},
      },
    } as never);
    const lane = projector.state().lanes.get('sess-1');
    expect(lane?.status).toBe('running');
    expect(lane?.compacting).toBe(true);
    expect(lane?.tools[0]).toMatchObject({ toolCallId: 'c9', isError: true });
    expect(projector.state().usage).toMatchObject({
      inputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 8,
      costUsd: 0.5,
    });
    projector.apply({
      type: 'inbox',
      items: [{ id: 'sub-1', mode: 'followUp' }],
    } as never);
    expect(projector.state().lanes.get('sess-1')?.queued).toEqual([
      'second prompt',
    ]);
  });

  it('folds worker and approval facts', () => {
    const projector = new PresentationProjector(SEED);
    projector.applyWorker({
      type: 'worker-start',
      workerId: 'w-1',
      role: 'implementer',
      workspace: '/wt/a',
    });
    projector.applyWorker({
      type: 'worker-update',
      workerId: 'w-1',
      status: 'busy',
    });
    projector.applyApproval({
      type: 'ask',
      requestId: 'r1',
      toolName: 'bash',
      capability: 'shell',
    });
    const state = projector.state();
    expect(state.workers.get('w-1')).toEqual({
      workerId: 'w-1',
      role: 'implementer',
      status: 'busy',
      workspace: '/wt/a',
    });
    expect(state.approvals).toEqual([
      { requestId: 'r1', toolName: 'bash', capability: 'shell' },
    ]);
    projector.applyApproval({ type: 'settled', requestId: 'r1' });
    projector.applyWorker({ type: 'worker-end', workerId: 'w-1' });
    expect(projector.state().approvals).toEqual([]);
    expect(projector.state().workers.size).toBe(0);
  });
});
