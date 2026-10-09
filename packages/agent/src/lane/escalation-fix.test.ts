// Escalation regression tests on the durable harness: (a) escalate ordering,
// (b) same-model no-op. The escalation applies through
// `conversation.configure({ model })`; the reserve re-clamp lives in the live
// CompactionPolicy getter.

import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EscalationLadder } from '../model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  MemoryStorage,
  type Storage,
} from '../pi-boundary.js';
import { bootLane, escalateLaneModel, type Lane } from './boot.js';

vi.mock('./interceptors/index.js', () => ({
  policyInterceptorHooks: () => [],
}));

vi.mock('../compaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../compaction.js')>();
  return {
    ...original,
    compactionSettings: (options: {
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

const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
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
    dir: `/tmp/kubic-lane-escalation/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // The boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

async function bootPinned(taskId = 'task-1') {
  const faux = fauxProvider({ models: [{ id: 'a' }, { id: 'b' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('hi')]);
  const modelA = faux.getModel('a');
  if (modelA === undefined) throw new Error("faux model 'a' missing");
  const booted = await bootLane({
    session: handle() as never,
    models,
    model: modelA,
    env: new FakeExecutionEnv({}),
    sessionId: 'sess-1',
    agentId: 'root',
    taskId,
  });
  LANES.push(booted);
  const ladder: EscalationLadder = {
    steps: ['faux/a', 'faux/b'],
    maxEscalations: 1,
    record: [],
  };
  return { booted, ladder };
}

function liveModelId(lane: Lane): Promise<string | undefined> {
  return lane.conversation
    .agent(BACKGROUND_CONTEXT)
    .then((agent) =>
      agent.model === undefined
        ? undefined
        : `${agent.model.provider}/${agent.model.modelId}`,
    );
}

describe('escalateLaneModel validates before recording', () => {
  it('failing configure leaves ladder budget, affinity, and sink untouched', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    vi.spyOn(booted.conversation, 'configure').mockRejectedValueOnce(
      new Error('configure rejected'),
    );
    await expect(
      escalateLaneModel(
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
      escalateLaneModel(
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

describe('escalateLaneModel rejects same-model no-ops', () => {
  it('from==to is refused without recording or emitting', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    await expect(
      escalateLaneModel(
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

describe('escalateLaneModel switches the live conversation', () => {
  it('fires exactly once: event recorded, model switched, second attempt refused', async () => {
    const { booted, ladder } = await bootPinned();
    const sink = vi.fn();
    const { affinity, event } = await escalateLaneModel(
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
      escalateLaneModel(
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
