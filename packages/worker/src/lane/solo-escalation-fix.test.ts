// RED-first regression tests for issue #82 review fix cycle 1:
// (a) escalate ordering, (b) same-model no-op, (c) registry reuse.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane, escalateSoloModel } from './solo.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

async function bootPinned(taskId = 'task-1') {
  const { MemorySessionRepo } = await import('../pi-boundary.js');
  const { createLadder } = await import('../model-select.js');
  const env = new FakeExecutionEnv({});
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  openSessions.push(session);
  const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const modelA = faux.getModel('a');
  if (modelA === undefined) throw new Error("faux model 'a' missing");
  const booted = await bootSoloLane({
    session,
    models,
    model: modelA,
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
    taskId,
  });
  const ladder = createLadder(['faux/a', 'faux/b'], { maxEscalations: 1 });
  return { booted, ladder };
}

describe('escalateSoloModel validates before recording (issue #82 fix a)', () => {
  it('failing setModel leaves ladder budget, affinity, and sink untouched', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    vi.spyOn(booted.lane, 'setModel').mockRejectedValueOnce(
      new Error('setModel rejected'),
    );
    await expect(
      escalateSoloModel(
        booted,
        ladder,
        'faux/b',
        'needs more',
        BACKGROUND_CONTEXT,
        sink,
      ),
    ).rejects.toThrow(/setModel rejected/);
    expect(ladder.record).toHaveLength(0);
    expect(booted.affinity?.modelId).toBe('faux/a');
    expect(booted.affinity?.escalations).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('malformed target id throws before recording or emitting', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    await expect(
      escalateSoloModel(
        booted,
        ladder,
        'not-a-provider-id',
        'bad id',
        BACKGROUND_CONTEXT,
        sink,
      ),
    ).rejects.toThrow(/provider\/id/);
    expect(ladder.record).toHaveLength(0);
    expect(booted.affinity?.modelId).toBe('faux/a');
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('escalateSoloModel rejects same-model no-ops (issue #82 fix b)', () => {
  it('from==to is refused without recording or emitting', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    await expect(
      escalateSoloModel(
        booted,
        ladder,
        'faux/a',
        'no-op',
        BACKGROUND_CONTEXT,
        sink,
      ),
    ).rejects.toThrow(/no-op|same-model/i);
    expect(ladder.record).toHaveLength(0);
    expect(booted.affinity?.modelId).toBe('faux/a');
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('registry reuse is absence-scoped and model-checked (issue #82 fix c)', () => {
  it('non-absence continuation errors propagate instead of spawning', async () => {
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const brokenRegistry = {
      continuation: () => {
        throw new Error('boom: registry backend down');
      },
      spawn: vi.fn(),
    };
    await expect(
      bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
        registry: brokenRegistry as never,
      }),
    ).rejects.toThrow(/boom/);
    expect(brokenRegistry.spawn).not.toHaveBeenCalled();
  });

  it('re-boot with a different model is refused instead of returning a stale binding', async () => {
    const { LaneRegistry } = await import('../prompts.js');
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const registry = new LaneRegistry();
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const modelA = faux.getModel('a');
    if (modelA === undefined) throw new Error("faux model 'a' missing");
    const first = await bootSoloLane({
      session,
      models,
      model: modelA,
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      registry,
    });
    expect(first.binding?.modelId).toBe('faux/a');
    const modelB = faux.getModel('b');
    if (modelB === undefined) throw new Error("faux model 'b' missing");
    await expect(
      bootSoloLane({
        session,
        models,
        model: modelB,
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
        registry,
      }),
    ).rejects.toThrow(/model/i);
  });
});

describe('escalation re-clamps the compaction reserve to the new model window', () => {
  it('escalating onto a small-window model lowers the harness reserve', async () => {
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const { createLadder } = await import('../model-select.js');
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider({
      models: [
        { id: 'big', contextWindow: 200000 },
        { id: 'small', contextWindow: 8192 },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const big = faux.getModel('big');
    if (big === undefined) throw new Error("faux model 'big' missing");
    const booted = await bootSoloLane({
      session,
      models,
      model: big,
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
      taskId: 'task-clamp',
    });
    const before =
      await booted.harness.getCompactionSettings(BACKGROUND_CONTEXT);
    expect(before.reserveTokens).toBe(16384);
    await escalateSoloModel(
      booted,
      createLadder(['faux/big', 'faux/small'], { maxEscalations: 1 }),
      'faux/small',
      'cheaper',
      BACKGROUND_CONTEXT,
    );
    const after =
      await booted.harness.getCompactionSettings(BACKGROUND_CONTEXT);
    expect(after.reserveTokens).toBe(2048);
    expect(after.keepRecentTokens).toBe(before.keepRecentTokens);
  });
});
