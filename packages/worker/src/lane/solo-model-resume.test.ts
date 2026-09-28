// Resumed-session model identity (issue #148; §21 persisted lane
// configuration, §26 items 1 and 4, §26.1). Pi restores the lane's stored
// model on attach; the boot selection only seeds NEW lanes. The documented
// rule: an explicit selection (`modelPolicy: 'selected'`) switches a
// differing stored model (setModel + reserve re-clamp + notice); otherwise
// the session keeps its own model and every surface reports it. A stored
// model that is no longer available fails closed with a named error.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from '../compaction.js';
import { ModelSelectError } from '../model-select.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxProvider,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane } from './solo.js';

const sessions: Session[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function catalog(providerId = 'faux') {
  const faux = fauxProvider({
    provider: providerId,
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 8192 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const big = faux.getModel('big');
  const small = faux.getModel('small');
  if (big === undefined || small === undefined) throw new Error('faux models');
  return { faux, models, big, small };
}

// A session whose lane was created on `big` (the stored model).
async function sessionOnBig(): Promise<Session> {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  sessions.push(session);
  const { models, big } = catalog();
  await bootSoloLane({
    session,
    models,
    model: big,
    env: new FakeExecutionEnv({}),
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  return session;
}

function promptOf(spy: ReturnType<typeof vi.spyOn>): string {
  const call = spy.mock.calls.at(-1);
  const options = call?.[0] as { systemPrompt?: string } | undefined;
  return options?.systemPrompt as string;
}

describe('resumed session model identity (issue #148)', () => {
  it('an explicit selection switches the stored model, re-clamps the reserve, and says so', async () => {
    const session = await sessionOnBig();
    const { models, small } = catalog();
    const notices: string[] = [];
    const solo = await bootSoloLane({
      session,
      models,
      model: small,
      modelPolicy: 'selected',
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    const live = await solo.lane.getModel(BACKGROUND_CONTEXT);
    expect(`${live?.provider}/${live?.id}`).toBe('faux/small');
    expect(`${solo.model.provider}/${solo.model.id}`).toBe('faux/small');
    expect(notices).toEqual([
      "model: session model 'faux/big' switched to 'faux/small' (explicit selection)",
    ]);
    const settings =
      await solo.harness.getCompactionSettings(BACKGROUND_CONTEXT);
    expect(settings.reserveTokens).toBe(
      effectiveReserveTokens(8192, DEFAULT_RESERVE_TOKENS),
    );
  });

  it('without an explicit selection the session keeps its stored model everywhere', async () => {
    const session = await sessionOnBig();
    const { models, small } = catalog();
    const notices: string[] = [];
    const create = vi.spyOn(AgentHarness, 'create');
    const solo = await bootSoloLane({
      session,
      models,
      model: small,
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    const live = await solo.lane.getModel(BACKGROUND_CONTEXT);
    expect(`${live?.provider}/${live?.id}`).toBe('faux/big');
    expect(`${solo.model.provider}/${solo.model.id}`).toBe('faux/big');
    // The prompt metadata names the model the lane actually runs.
    expect(promptOf(create)).toContain('faux/big');
    expect(promptOf(create)).not.toContain('faux/small');
    // The reserve is clamped to the effective model's window.
    const settings =
      await solo.harness.getCompactionSettings(BACKGROUND_CONTEXT);
    expect(settings.reserveTokens).toBe(
      effectiveReserveTokens(200000, DEFAULT_RESERVE_TOKENS),
    );
    expect(notices).toEqual([
      "model: session keeps its own model 'faux/big' (selected default 'faux/small' not applied; pin a model to switch)",
    ]);
  });

  it('a matching or fresh lane boots silently on the selection', async () => {
    const session = await sessionOnBig();
    const { models, big } = catalog();
    const notices: string[] = [];
    const solo = await bootSoloLane({
      session,
      models,
      model: big,
      modelPolicy: 'selected',
      onModelNotice: (line) => notices.push(line),
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    expect(`${solo.model.provider}/${solo.model.id}`).toBe('faux/big');
    expect(notices).toEqual([]);
  });

  it('a stored model whose provider is absent fails closed with a named error', async () => {
    const session = await sessionOnBig();
    const other = catalog('other');
    const booted = bootSoloLane({
      session,
      models: other.models,
      model: other.small,
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    await expect(booted).rejects.toBeInstanceOf(ModelSelectError);
    await expect(booted).rejects.toThrow(
      "session model 'faux/big' is unavailable: provider 'faux' is not registered (pin a model to switch this session)",
    );
  });

  it('a stored model missing from its provider fails closed with a named error', async () => {
    const session = await sessionOnBig();
    const faux = fauxProvider({
      models: [{ id: 'small', contextWindow: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    await expect(
      bootSoloLane({
        session,
        models,
        model: faux.getModel(),
        env: new FakeExecutionEnv({}),
        sessionId: session.metadata.id,
        agentId: 'root',
      }),
    ).rejects.toThrow(
      "session model 'faux/big' is unavailable: model 'big' is not registered on provider 'faux' (pin a model to switch this session)",
    );
  });

  it('reconciles silently when no notice sink is given', async () => {
    const session = await sessionOnBig();
    const { models, small } = catalog();
    const kept = await bootSoloLane({
      session,
      models,
      model: small,
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    expect(kept.model.id).toBe('big');
    const switched = await bootSoloLane({
      session,
      models,
      model: small,
      modelPolicy: 'selected',
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    expect(switched.model.id).toBe('small');
  });
});
