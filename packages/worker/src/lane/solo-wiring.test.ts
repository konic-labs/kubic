// Solo lane prompt/compaction wiring (issue #82).
// RED: solo.ts never calls prompts.ts / compaction.ts — every test below
// must fail until the lane wires them in.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane } from './solo.js';
import { kubicToolsToPiTools } from './tools-adapter.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

describe('solo boot hands the assembled system prompt to the harness (issue #82)', () => {
  it('passes assembleSystemPrompt bytes to AgentHarness.create, not the ad-hoc default', async () => {
    const { assembleSystemPrompt } = await import('../prompts.js');
    const createSpy = vi.spyOn(AgentHarness, 'create');
    try {
      const env = new FakeExecutionEnv({});
      const repo = new (await import('../pi-boundary.js')).MemorySessionRepo();
      const session = await repo.create({}, BACKGROUND_CONTEXT);
      openSessions.push(session);
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('hi')]);
      const model = faux.getModel();
      await bootSoloLane({
        session,
        models,
        model,
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const handed = (
        createSpy.mock.calls[0] as unknown as Array<{
          systemPrompt: string;
        }>
      )[0].systemPrompt;
      const toolNames = kubicToolsToPiTools().map((t) => t.name);
      const expected = assembleSystemPrompt({
        role: [
          'You are a coding agent working in a terminal.',
          'Use the read, write, edit, grep, find, ls, and bash tools to inspect and change files.',
          'Keep answers short and technical.',
        ].join('\n'),
        cwd: env.cwd,
        toolNames,
        metadata: {
          agent: 'root',
          lane: 'main',
          model: `${model.provider}/${model.id}`,
        },
      });
      expect(handed).toBe(expected);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('passes an explicit systemPrompt override through byte-identical', async () => {
    const createSpy = vi.spyOn(AgentHarness, 'create');
    try {
      const env = new FakeExecutionEnv({});
      const repo = new (await import('../pi-boundary.js')).MemorySessionRepo();
      const session = await repo.create({}, BACKGROUND_CONTEXT);
      openSessions.push(session);
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('hi')]);
      await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
        systemPrompt: 'custom bytes\nline two',
      });
      const handed = (
        createSpy.mock.calls[0] as unknown as Array<{
          systemPrompt: string;
        }>
      )[0].systemPrompt;
      expect(handed).toBe('custom bytes\nline two');
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe('solo boot binds the lane registry (issue #82, rule 5)', () => {
  it('spawns the binding on boot and reuses it on continuation', async () => {
    const { LaneRegistry } = await import('../prompts.js');
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const registry = new LaneRegistry();
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const first = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      registry,
    });
    expect(first.binding).toMatchObject({
      sessionId: session.metadata.id,
      lane: 'main',
      modelId: 'faux/faux-1',
    });
    expect(registry.continuation(session.metadata.id, 'main').modelId).toBe(
      'faux/faux-1',
    );
    // No harness.close between boots: close shuts the session itself, so
    // the continuation re-attaches while the first harness is still open.
    const second = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      registry,
    });
    expect(second.binding?.modelId).toBe('faux/faux-1');
  });
});

describe('solo turn-loop compaction (issue #82, rule 7)', () => {
  const CONTEXT_WINDOW = 200000;
  const THRESHOLD = CONTEXT_WINDOW - 16384;

  async function bootLane() {
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    return bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
    });
  }

  it('stays quiet below and at the real threshold', async () => {
    const { maybeCompactSoloLane } = await import('./solo.js');
    const solo = await bootLane();
    const compactSpy = vi.spyOn(solo.lane, 'compact');
    try {
      for (const tokens of [THRESHOLD - 1, THRESHOLD]) {
        const decision = await maybeCompactSoloLane(
          solo,
          { contextWindow: CONTEXT_WINDOW, contextTokens: tokens },
          BACKGROUND_CONTEXT,
        );
        expect(decision).toMatchObject({ checked: true, compacted: false });
      }
      expect(compactSpy).not.toHaveBeenCalled();
    } finally {
      compactSpy.mockRestore();
    }
  });

  it('compacts one above threshold with a fresh routing id and no cache write', async () => {
    const { maybeCompactSoloLane } = await import('./solo.js');
    const solo = await bootLane();
    const compactSpy = vi
      .spyOn(solo.lane, 'compact')
      .mockResolvedValue({ ok: true, value: { marker: 'compacted' } } as never);
    const usageSpy = vi.spyOn(solo.lane, 'recordUsage');
    try {
      const decision = await maybeCompactSoloLane(
        solo,
        {
          contextWindow: CONTEXT_WINDOW,
          contextTokens: THRESHOLD + 1,
          focus: 'focus on the auth flow',
          newRoutingId: () => 'fresh-routing-1',
        },
        BACKGROUND_CONTEXT,
      );
      expect(compactSpy).toHaveBeenCalledTimes(1);
      const args = compactSpy.mock.calls[0] as unknown as [
        { customInstructions?: string },
      ];
      expect(args[0].customInstructions).toContain('focus on the auth flow');
      expect(decision).toMatchObject({ checked: true, compacted: true });
      if (decision.checked !== true || decision.compacted !== true) {
        throw new Error('expected compaction');
      }
      expect(decision.route.routingId).toBe('fresh-routing-1');
      expect(decision.route.routingId).not.toBe(solo.sessionId);
      expect(decision.route.cacheRetention).toBe('none');
      expect(decision.route.cacheWriteEnabled).toBe(false);
      expect(usageSpy).not.toHaveBeenCalled();
    } finally {
      compactSpy.mockRestore();
      usageSpy.mockRestore();
    }
  });

  it('refuses a recycled routing id and skips batch-terminal checkpoints', async () => {
    const { maybeCompactSoloLane } = await import('./solo.js');
    const solo = await bootLane();
    const compactSpy = vi.spyOn(solo.lane, 'compact');
    try {
      await expect(
        maybeCompactSoloLane(
          solo,
          {
            contextWindow: CONTEXT_WINDOW,
            contextTokens: THRESHOLD + 1,
            newRoutingId: () => solo.sessionId,
          },
          BACKGROUND_CONTEXT,
        ),
      ).rejects.toThrow(/fresh/);
      const skipped = await maybeCompactSoloLane(
        solo,
        {
          contextWindow: CONTEXT_WINDOW,
          contextTokens: THRESHOLD + 1,
          batchTerminal: true,
        },
        BACKGROUND_CONTEXT,
      );
      expect(skipped).toMatchObject({
        checked: false,
        reason: 'checkpoint-skipped',
      });
      expect(compactSpy).not.toHaveBeenCalled();
    } finally {
      compactSpy.mockRestore();
    }
  });
});

describe('solo boot wires harness compaction settings (issue #82)', () => {
  it('passes Kubic reserve tokens as the harness compaction budget', async () => {
    const { DEFAULT_RESERVE_TOKENS } = await import('../compaction.js');
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const createSpy = vi.spyOn(AgentHarness, 'create');
    try {
      const env = new FakeExecutionEnv({});
      const repo = new MemorySessionRepo();
      const session = await repo.create({}, BACKGROUND_CONTEXT);
      openSessions.push(session);
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage('hi')]);
      await bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env,
        sessionId: session.metadata.id,
        agentId: 'root',
      });
      const handed = (
        createSpy.mock.calls[0] as unknown as Array<{
          compaction: {
            enabled: boolean;
            reserveTokens: number;
            keepRecentTokens: number;
          };
        }>
      )[0].compaction;
      expect(handed).toEqual({
        enabled: true,
        reserveTokens: DEFAULT_RESERVE_TOKENS,
        keepRecentTokens: 20000,
      });
      expect(handed.reserveTokens).toBe(16384);
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe('solo model escalation through the lane path (issue #82, rule 6)', () => {
  it('fires exactly once: event recorded, lane model switched, second attempt refused', async () => {
    const { createLadder } = await import('../model-select.js');
    const { MemorySessionRepo } = await import('../pi-boundary.js');
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider({
      models: [{ id: 'a' }, { id: 'b' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const booted = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      taskId: 'task-1',
    });
    expect(booted.affinity?.modelId).toBe('faux/a');
    const ladder = createLadder(['faux/a', 'faux/b'], { maxEscalations: 1 });
    const seen: Array<{ type: string }> = [];
    const { escalateSoloModel } = await import('./solo.js');
    const { affinity, event } = await escalateSoloModel(
      booted,
      ladder,
      'faux/b',
      'needs more',
      BACKGROUND_CONTEXT,
      (e) => void seen.push(e),
    );
    expect(event).toMatchObject({
      type: 'model-escalation',
      taskId: 'task-1',
      from: 'faux/a',
      to: 'faux/b',
    });
    expect(seen).toHaveLength(1);
    expect(affinity.modelId).toBe('faux/b');
    expect(affinity.escalations).toHaveLength(1);
    const info = await booted.lane.inspectExecution(BACKGROUND_CONTEXT);
    expect(info.configuredModel).toEqual({ provider: 'faux', modelId: 'b' });
    await expect(
      escalateSoloModel(
        booted,
        ladder,
        'faux/b',
        'again',
        BACKGROUND_CONTEXT,
        (e) => void seen.push(e),
      ),
    ).rejects.toThrow(/bounded/);
    expect(seen).toHaveLength(1);
  });
});
