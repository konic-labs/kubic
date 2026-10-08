// 's host-side projector: folds the replicated event stream
// into a KubicPresentationState. Pure — no I/O, no harness.
import { describe, expect, it } from 'vitest';
import type { KubicLaneEvent } from '../../../worker/src/lane/events.js';
import { PresentationProjector } from './projector.js';

const SEED = {
  sessionId: 'sess-1',
  model: 'faux/faux-1',
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

describe('presentation projector', () => {
  it('starts from the seed with one idle lane', () => {
    const state = new PresentationProjector(SEED).state();
    expect(state.session).toEqual({
      sessionId: 'sess-1',
      model: 'faux/faux-1',
      approvalsSkipped: false,
      workspace: '/repo',
    });
    expect(state.lane).toEqual({
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
    const lane = projector.state().lane;
    expect(lane.status).toBe('done');
    expect(lane.tools).toEqual([
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
    expect(lane.compacting).toBe(false);
    expect(lane.retrying).toBeUndefined();
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
    const lane = projector.state().lane;
    expect(lane.status).toBe('running');
    expect(lane.compacting).toBe(true);
    expect(lane.tools[0]).toMatchObject({ toolCallId: 'c9', isError: true });
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
    expect(projector.state().lane.queued).toEqual(['second prompt']);
  });

  it('folds approval facts', () => {
    const projector = new PresentationProjector(SEED);
    projector.applyApproval({
      type: 'ask',
      requestId: 'r1',
      toolName: 'bash',
      capability: 'shell',
    });
    const state = projector.state();
    expect(state.approvals).toEqual([
      { requestId: 'r1', toolName: 'bash', capability: 'shell' },
    ]);
    projector.applyApproval({ type: 'settled', requestId: 'r1' });
    expect(projector.state().approvals).toEqual([]);
  });
});

describe('presentation projector regressions', () => {
  it('clears the previous turn calls at a turn boundary', () => {
    // The lane's `tools` list is a running list across turns; only a snapshot
    // replaces it. The tree renders it as the CURRENT turn, so the projector
    // must draw the boundary itself — otherwise turn 1's calls show up as
    // live rows again in turn 2 and the rollup counts them twice.
    const projector = new PresentationProjector(SEED);
    projector.apply({ type: 'run-start', inputs: [1 as never] });
    projector.apply({
      type: 'tool-start',
      toolCallId: 'c1',
      toolName: 'read',
    } as never);
    projector.apply({
      type: 'tool-end',
      toolCallId: 'c1',
      toolName: 'read',
      isError: false,
    } as never);
    expect(projector.state().lane.tools).toHaveLength(1);
    // Turn 2.
    projector.apply({ type: 'run-start', inputs: [2 as never] });
    expect(projector.state().lane.tools).toEqual([]);
    projector.apply({
      type: 'tool-start',
      toolCallId: 'c2',
      toolName: 'edit',
    } as never);
    const tools = projector.state().lane.tools;
    expect(tools.map((tool) => tool.toolCallId)).toEqual(['c2']);
  });

  it('replaces the usage totals from a re-delivered snapshot', () => {
    // The snapshot's usage is the session's CUMULATIVE pi.usage ledger (the
    // same value the status bar is seeded from), and every other field of
    // that branch is REPLACE. Adding it doubles the totals on the watch's
    // overflow rebase.
    const snapshot = {
      type: 'snapshot',
      entries: [],
      run: [9 as never],
      tools: [],
      compactions: [],
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
    } as never;
    const projector = new PresentationProjector(SEED);
    projector.apply(snapshot);
    projector.apply(snapshot);
    expect(projector.state().usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      costUsd: 0.5,
    });
  });

  it('keeps the queued rows after a later lane event', () => {
    // The app writes `lane.queued` on EVERY applyPresentation, so a state
    // that resolves the inbox only at the `inbox` event wipes the rows on
    // the next event (a tool end, a delta) and they stay gone for the rest
    // of the turn. The loop hands its in-place map in, so the resolution is
    // always current.
    const queuedText = new Map([['sub-1', 'second prompt']]);
    const projector = new PresentationProjector(SEED);
    projector.setQueuedText(queuedText);
    projector.apply({
      type: 'inbox',
      items: [{ id: 'sub-1', mode: 'followUp' }],
    } as never);
    expect(projector.state().lane.queued).toEqual(['second prompt']);
    projector.apply({
      type: 'tool-start',
      toolCallId: 'c1',
      toolName: 'read',
    } as never);
    expect(projector.state().lane.queued).toEqual(['second prompt']);
    // The harness placed it (the loop drops the id when the run starts): the
    // row goes with it, with no extra event needed.
    queuedText.delete('sub-1');
    expect(projector.state().lane.queued).toEqual([]);
  });
});

describe('the snapshot usage ledger', () => {
  const snapshotWith = (usage: unknown): never =>
    ({
      type: 'snapshot',
      entries: [],
      tools: [],
      compactions: [],
      usage,
    }) as never;

  it('sums the per-model and per-tool buckets into the totals', () => {
    // The attach snapshot carries the conversation's cumulative `pi.usage`
    // ledger; the tree's root row and the status bar both read the totals.
    const projector = new PresentationProjector(SEED);
    projector.apply(
      snapshotWith({
        models: {
          'faux/one': {
            input: 1000,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1200,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.02,
            },
          },
        },
        tools: {
          bash: {
            input: 500,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 600,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.01,
            },
          },
        },
      }),
    );
    expect(projector.state().usage).toMatchObject({
      costUsd: 0.03,
      inputTokens: 1500,
      outputTokens: 300,
    });
  });

  it('contributes nothing for a malformed ledger', () => {
    const projector = new PresentationProjector(SEED);
    projector.apply(snapshotWith({ models: { a: null }, tools: 'nope' }));
    expect(projector.state().usage).toMatchObject({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
