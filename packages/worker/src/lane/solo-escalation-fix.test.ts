// RED-first regression tests for issue #82 review fix cycle 1, ported to
// the durable harness in #394: (a) escalate ordering, (b) same-model no-op,
// (c) registry reuse. The escalation now applies through
// `conversation.configure({ model })`; the reserved re-clamp moved to the
// live CompactionPolicy getter (#399).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  type Storage,
} from '../pi-boundary.js';
import { bootSoloLane, escalateSoloModel, type SoloLane } from './solo.js';

vi.mock('./interceptors.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    soloCompactionSettings: (options: {
      configuredReserveTokens?: number;
      currentWindow?: () => number | undefined;
    }) => ({
      enabled: true,
      keepRecentTokens: 20_000,
      get reserveTokens() {
        return (
          options.configuredReserveTokens ?? original.DEFAULT_RESERVE_TOKENS
        );
      },
    }),
  };
});

vi.mock('./tools-adapter.js', async () => {
  const { defineTool, Type } = await import('../pi-boundary.js');
  const { OPERATIONS } = await import('../ops/registry.js');
  return {
    kubicToolsToPiTools: () =>
      Object.keys(OPERATIONS).map((name) =>
        defineTool({
          name,
          description: `${name} (faux)`,
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: 'text' as const, text: name }],
          }),
        }),
      ),
  };
});

const SOLOS: SoloLane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
});

type TestSession = {
  id: string;
  dir: string;
  storage: Storage;
  meta: { cwd: string; createdAt: string };
  adopt(): Storage;
  release(context: Context): Promise<void>;
};
function handle(id = 'sess-1'): TestSession {
  const storage = new MemoryStorage();
  return {
    id,
    dir: `/tmp/kubic-solo-escalation/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // #395/D8.1: the boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

async function bootPinned(taskId = 'task-1') {
  const { createLadder } = await import('../model-select.js');
  const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const modelA = faux.getModel('a');
  if (modelA === undefined) throw new Error("faux model 'a' missing");
  const booted = await bootSoloLane({
    session: handle() as never,
    models,
    model: modelA,
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
    taskId,
  });
  SOLOS.push(booted);
  const ladder = createLadder(['faux/a', 'faux/b'], { maxEscalations: 1 });
  return { booted, ladder };
}

function liveModelId(solo: SoloLane): Promise<string | undefined> {
  return solo.conversation
    .agent(BACKGROUND_CONTEXT)
    .then((agent) =>
      agent.model === undefined
        ? undefined
        : `${agent.model.provider}/${agent.model.modelId}`,
    );
}

describe('escalateSoloModel validates before recording (issue #82 fix a)', () => {
  it('failing configure leaves ladder budget, affinity, and sink untouched', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    vi.spyOn(booted.conversation, 'configure').mockRejectedValueOnce(
      new Error('configure rejected'),
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
    ).rejects.toThrow(/configure rejected/);
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
        session: handle() as never,
        models,
        model: faux.getModel(),
        env: new FakeExecutionEnv({}),
        sessionId: 'sess-1',
        agentId: 'root',
        registry: brokenRegistry as never,
      }),
    ).rejects.toThrow(/boom/);
    expect(brokenRegistry.spawn).not.toHaveBeenCalled();
  });

  it('re-boot with a different model is refused instead of returning a stale binding', async () => {
    const { LaneRegistry } = await import('../prompts.js');
    const registry = new LaneRegistry();
    const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const modelA = faux.getModel('a');
    const modelB = faux.getModel('b');
    if (modelA === undefined || modelB === undefined) {
      throw new Error('faux models missing');
    }
    const session = handle();
    const first = await bootSoloLane({
      session: session as never,
      models,
      model: modelA,
      env: new FakeExecutionEnv({}),
      sessionId: 'sess-1',
      agentId: 'root',
      registry,
    });
    await first.close(BACKGROUND_CONTEXT);
    expect(first.binding?.modelId).toBe('faux/a');
    // Issue #148: only an EXPLICIT selection moves a resumed session off its
    // stored model — an unpinned re-boot keeps 'faux/a', which is exactly
    // the bound model. The explicit switch is the re-boot that must refuse.
    await expect(
      bootSoloLane({
        session: handle() as never,
        models,
        model: modelB,
        modelPolicy: 'selected',
        env: new FakeExecutionEnv({}),
        sessionId: 'sess-1',
        agentId: 'root',
        registry,
      }),
    ).rejects.toThrow(/model/i);
  });
});

describe('escalateSoloModel switches the live conversation (issue #82 rule 6)', () => {
  it('fires exactly once: event recorded, model switched, second attempt refused', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    const { affinity, event } = await escalateSoloModel(
      booted,
      ladder,
      'faux/b',
      'needs more',
      BACKGROUND_CONTEXT,
      sink,
    );
    expect(event).toMatchObject({
      type: 'model-escalation',
      taskId: 'task-1',
      from: 'faux/a',
      to: 'faux/b',
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(affinity.modelId).toBe('faux/b');
    expect(affinity.escalations).toHaveLength(1);
    expect(await liveModelId(booted)).toBe('faux/b');
    // A second, otherwise-distinct step is refused by the ladder bound
    // (maxEscalations: 1) — not by the same-model guard.
    await expect(
      escalateSoloModel(
        booted,
        ladder,
        'faux/a',
        'again',
        BACKGROUND_CONTEXT,
        sink,
      ),
    ).rejects.toThrow(/escalation bounded/);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(ladder.record).toHaveLength(1);
    expect(booted.affinity?.modelId).toBe('faux/b');
    expect(await liveModelId(booted)).toBe('faux/b');
  });
});
