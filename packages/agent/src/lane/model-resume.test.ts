// Resumed-session model identity on the durable harness (persisted conversation
// agent, items 1 and 4, ported). The root conversation's `pi.agent` document
// restores the stored model; the boot selection only seeds a NEW conversation.
// The documented rule: an explicit selection (`modelPolicy: 'selected'`)
// switches a differing stored model (configure + notice); otherwise the session
// keeps its own model and every surface reports it. A stored model that is no
// longer available fails closed with a named error.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSelectError } from '../model-select.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  openNodeJsonlStorage,
  type Storage,
  SystemEntry,
} from '../pi-boundary.js';
import type { TestSession } from '../test-support/session-handle.js';
import { bootLane, type Lane, PROMPT_SECTION } from './boot.js';

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
            output: [{ type: 'text' as const, text: name }],
          }),
        }),
      ),
  };
});

const DIRS: string[] = [];
const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function handle(storage: Storage, id = 'sess-1'): TestSession {
  return {
    id,
    dir: `/tmp/kubic-lane-resume/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    // The boot adopts the storage, so the handle must expose it.
    adopt: () => storage,
    release: vi.fn(async () => undefined),
  };
}

function catalog(providerId = 'faux') {
  const faux = fauxProvider({
    provider: providerId,
    models: [
      { id: 'big', contextWindow: 200_000 },
      { id: 'small', contextWindow: 8_192 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const big = faux.getModel('big');
  const small = faux.getModel('small');
  if (big === undefined || small === undefined) throw new Error('faux models');
  return { faux, models, big, small };
}

// A session whose root conversation was booted once on `big` (the stored
// model): close it, hand back a fresh storage over the same sessions dir.
async function sessionOnBig(id = 'resume'): Promise<Storage> {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-lane-resume-'));
  DIRS.push(dir);
  const { faux, models, big } = catalog();
  faux.setResponses([fauxAssistantMessage('hi')]);
  const seeding = await bootLane({
    session: handle(
      await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT),
      id,
    ) as never,
    models,
    model: big,
    env: new FakeExecutionEnv({}),
    sessionId: id,
    agentId: 'root',
  });
  await seeding.close(BACKGROUND_CONTEXT);
  return openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
}

async function promptOf(lane: Lane): Promise<string> {
  const page = await lane.conversation.entries(
    {},
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const system = page.items.find((entry) => SystemEntry.is(entry));
  const message = (
    system?.model as unknown as Array<{
      sections?: Record<string, string | null>;
    }>
  )?.[0];
  return message?.sections?.[PROMPT_SECTION] ?? '';
}

async function driveOneTurn(lane: Lane): Promise<void> {
  const settled = await (
    await lane.conversation.submit(
      { type: 'input', content: 'hi' },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe('done');
}

function liveModel(lane: Lane): Promise<string | undefined> {
  return lane.conversation
    .agent(BACKGROUND_CONTEXT)
    .then((agent) =>
      agent.model === undefined
        ? undefined
        : `${agent.model.provider}/${agent.model.modelId}`,
    );
}

describe('resumed session model identity', () => {
  it('an explicit selection switches the stored model and says so', async () => {
    const storage = await sessionOnBig();
    const { faux, models, small } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const notices: string[] = [];
    const lane = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: small,
      modelPolicy: 'selected',
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(lane);
    expect(await liveModel(lane)).toBe('faux/small');
    expect(`${lane.model.provider}/${lane.model.id}`).toBe('faux/small');
    expect(notices).toEqual([
      "model: session model 'faux/big' switched to 'faux/small' (explicit selection)",
    ]);
  });

  it('without an explicit selection the session keeps its stored model everywhere', async () => {
    const storage = await sessionOnBig();
    const { faux, models, small } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const notices: string[] = [];
    const lane = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: small,
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(lane);
    expect(await liveModel(lane)).toBe('faux/big');
    expect(`${lane.model.provider}/${lane.model.id}`).toBe('faux/big');
    // The prompt metadata names the model the conversation actually runs.
    await driveOneTurn(lane);
    const prompt = await promptOf(lane);
    expect(prompt).toContain('model=faux/big');
    expect(prompt).not.toContain('faux/small');
    expect(notices).toEqual([
      "model: session keeps its own model 'faux/big' (selected default 'faux/small' not applied; pin a model to switch)",
    ]);
  });

  it('a matching or fresh lane boots silently on the selection', async () => {
    const storage = await sessionOnBig();
    const { faux, models, big } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const notices: string[] = [];
    const lane = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: big,
      modelPolicy: 'selected',
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(lane);
    expect(`${lane.model.provider}/${lane.model.id}`).toBe('faux/big');
    expect(notices).toEqual([]);
  });

  it('a stored model whose provider is absent fails closed with a named error', async () => {
    const storage = await sessionOnBig();
    const other = catalog('other');
    const error = await bootLane({
      session: handle(storage, 'resume') as never,
      models: other.models,
      model: other.small,
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelSelectError);
    expect((error as Error).message).toBe(
      "session model 'faux/big' is unavailable: provider 'faux' is not registered (pin a model to switch this session)",
    );
  });

  it('a stored model missing from its provider fails closed with a named error', async () => {
    const storage = await sessionOnBig();
    const faux = fauxProvider({
      models: [{ id: 'small', contextWindow: 8_192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    await expect(
      bootLane({
        session: handle(storage, 'resume') as never,
        models,
        model: faux.getModel(),
        env: new FakeExecutionEnv({}),
        sessionId: 'resume',
        agentId: 'root',
      }),
    ).rejects.toThrow(
      "session model 'faux/big' is unavailable: model 'big' is not registered on provider 'faux' (pin a model to switch this session)",
    );
  });

  it('reconciles silently when no notice sink is given', async () => {
    const storage = await sessionOnBig();
    const { faux, models, small } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const kept = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: small,
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(kept);
    expect(kept.model.id).toBe('big');
  });
});

describe('a resumed session never keeps a model the enterprise gate refuses', () => {
  it('drops a refused stored model for the (already gated) selection and says so', async () => {
    const storage = await sessionOnBig();
    const { faux, models, small } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const notices: string[] = [];
    const asked: string[] = [];
    const lane = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: small,
      onModelNotice: (line) => notices.push(line),
      policy: {
        modelAllowed: (provider, modelId) => {
          asked.push(`${provider}/${modelId}`);
          return modelId !== 'big';
        },
      },
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(lane);
    expect(await liveModel(lane)).toBe('faux/small');
    expect(`${lane.model.provider}/${lane.model.id}`).toBe('faux/small');
    // The gate is asked about the STORED model, and only that one.
    expect(asked).toEqual(['faux/big']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("'faux/big'");
    expect(notices[0]).toContain("'faux/small'");
    expect(notices[0]).toContain('enterprise policy');
  });

  it('keeps an allowed stored model exactly as before', async () => {
    const storage = await sessionOnBig();
    const { faux, models, small } = catalog();
    faux.setResponses([fauxAssistantMessage('hi')]);
    const lane = await bootLane({
      session: handle(storage, 'resume') as never,
      models,
      model: small,
      policy: { modelAllowed: () => true },
      env: new FakeExecutionEnv({}),
      sessionId: 'resume',
      agentId: 'root',
    });
    LANES.push(lane);
    expect(await liveModel(lane)).toBe('faux/big');
  });
});
