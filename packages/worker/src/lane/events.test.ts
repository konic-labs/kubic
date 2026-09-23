// Slice B: single harness-event consumer + gap-free watch (§15, §9.1).
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type HarnessEvent,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import {
  attachLaneEvents,
  type KubicLaneEvent,
  toKubicLaneEvent,
  watchLane,
} from './events.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

function laneEvent(event: object, lane: string): HarnessEvent {
  return { ...event, lane } as unknown as HarnessEvent;
}

const FULL_USAGE = { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 };

describe('harness event consumer (issue #11, slice B)', () => {
  it('maps run start/end for our lane', () => {
    const start = toKubicLaneEvent(
      laneEvent({ type: 'run_start', runId: 'r-1', startedAt: 7 }, 'main'),
      'main',
    );
    expect(start).toEqual({
      type: 'run-start',
      lane: 'main',
      runId: 'r-1',
      startedAt: 7,
    });
    const end = toKubicLaneEvent(
      laneEvent(
        {
          type: 'run_end',
          runId: 'r-1',
          fromTipId: null,
          tipId: 'e-9',
          endedAt: 9,
          status: 'completed',
        },
        'main',
      ),
      'main',
    );
    expect(end?.type).toBe('run-end');
  });

  it('maps tool start/end with Kubic op names', () => {
    const start = toKubicLaneEvent(
      laneEvent(
        {
          type: 'tool_start',
          runId: 'r-1',
          turnId: 't-1',
          toolCallId: 'c-1',
          toolName: 'read',
          args: { path: 'a.txt' },
        },
        'main',
      ),
      'main',
    );
    expect(start).toEqual({
      type: 'tool-start',
      lane: 'main',
      runId: 'r-1',
      turnId: 't-1',
      toolCallId: 'c-1',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    const end = toKubicLaneEvent(
      laneEvent(
        {
          type: 'tool_end',
          runId: 'r-1',
          turnId: 't-1',
          toolCallId: 'c-1',
          toolName: 'read',
          result: { content: [], details: {} },
          isError: false,
          terminate: false,
        },
        'main',
      ),
      'main',
    );
    expect(end?.type).toBe('tool-end');
  });

  it('maps usage with lane attribution and faults globally', () => {
    const usage = toKubicLaneEvent(
      {
        type: 'usage',
        lane: 'main',
        row: { id: 'u-1', seq: 0, usage: FULL_USAGE, adjustment: false },
        totals: FULL_USAGE,
      } as HarnessEvent,
      'main',
    );
    expect(usage?.type).toBe('usage');
    const otherLane = toKubicLaneEvent(
      laneEvent({ type: 'run_start', runId: 'r-x', startedAt: 1 }, 'worker-a'),
      'main',
    );
    expect(otherLane).toBeUndefined();
    const fault = toKubicLaneEvent(
      { type: 'fault', code: 'boom', message: 'kaboom' },
      'main',
    );
    expect(fault).toEqual({ type: 'fault', code: 'boom', message: 'kaboom' });
  });

  it('ignores non-§15 event types', () => {
    const update = toKubicLaneEvent(
      laneEvent(
        {
          type: 'message_update',
          runId: 'r-1',
          message: { role: 'assistant', content: [] },
          event: { type: 'text_delta', delta: 'hi' },
        } as unknown as HarnessEvent,
        'main',
      ),
      'main',
    );
    expect(update).toBeUndefined();
  });

  it('delivers run + usage events for a live faux turn', async () => {
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('done')]);
      const { harness, lane } = await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
      });
      const received: KubicLaneEvent[] = [];
      const detach = attachLaneEvents(harness, 'main', (event) => {
        received.push(event);
      });
      try {
        const admission = await lane.accept(
          { kind: 'prompt', prompt: 'say done' },
          BACKGROUND_CONTEXT,
        );
        if (!admission.ok) throw new Error('accept failed');
        const driven = await driveToSettled(
          lane,
          admission.value.operationId,
          BACKGROUND_CONTEXT,
        );
        expect(driven.kind).toBe('settled');
      } finally {
        detach();
      }
      const types = received.map((event) => event.type);
      expect(types).toContain('run-start');
      expect(types).toContain('run-end');
      const usages = received.filter((event) => event.type === 'usage');
      expect(usages.length).toBeGreaterThan(0);
      for (const event of usages) {
        if (event.type === 'usage') expect(event.lane).toBe('main');
      }
    }
  });

  it('re-watch resumes from the latest snapshot', async () => {
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('done')]);
      const { lane } = await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
      });
      const watch = await watchLane(lane, BACKGROUND_CONTEXT);
      try {
        const admission = await lane.accept(
          { kind: 'prompt', prompt: 'say done' },
          BACKGROUND_CONTEXT,
        );
        if (!admission.ok) throw new Error('accept failed');
        await driveToSettled(
          lane,
          admission.value.operationId,
          BACKGROUND_CONTEXT,
        );
        const fresh = await watch.resnapshot(BACKGROUND_CONTEXT);
        expect(fresh.tipId).not.toBeNull();
      } finally {
        watch.unsubscribe();
      }
    }
  });
});
