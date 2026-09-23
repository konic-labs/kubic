import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

async function boot(text: string) {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'lane reads this\n');
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  const booted = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  openSessions.push(session);
  return booted;
}

describe('solo lane boot (issue #11, slice A)', () => {
  it('boots one lane with the 7 Kubic tools and no IPC', async () => {
    const { harness } = await boot('hi');
    const tools = await harness.getTools(BACKGROUND_CONTEXT);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bash',
      'edit',
      'find',
      'grep',
      'ls',
      'read',
      'write',
    ]);
    expect(AgentHarness).toBeDefined();
  });

  it('drives a faux text turn to settled', async () => {
    const { lane } = await boot('done');
    const admission = await lane.accept(
      { kind: 'prompt', prompt: 'say done' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    const outcome = await driveToSettled(
      lane,
      admission.value.operationId,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.kind).toBe('settled');
  });

  it('executes a Kubic op for a faux tool call', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'lane reads this\n');
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })]),
      fauxAssistantMessage('read it'),
    ]);
    const { lane } = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
    });
    const admission = await lane.accept(
      { kind: 'prompt', prompt: 'read the file' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    const outcome = await driveToSettled(
      lane,
      admission.value.operationId,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.kind).toBe('settled');
    // The op executed against the fake env: its result is in the transcript.
    const entries = await lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).toContain('lane reads this');
    openSessions.push(session);
  });
});

describe('driveToSettled outcome routing (issue #11, slice A)', () => {
  it('waits for notBefore on retry then drives again', async () => {
    const seen: string[] = [];
    const sleeps: number[] = [];
    const lane = {
      drive: async (options: { operationId: string }) => {
        seen.push(options.operationId);
        if (seen.length === 1) {
          return {
            ok: true as const,
            value: {
              kind: 'waiting' as const,
              operationId: 'op-1',
              reason: 'retry' as const,
              notBefore: Date.now() + 50,
            },
          };
        }
        return {
          ok: true as const,
          value: { kind: 'settled' as const, outcome: { marker: true } },
        };
      },
    };
    const outcome = await driveToSettled(lane, 'op-1', BACKGROUND_CONTEXT, {
      sleep: async (ms: number) => void sleeps.push(ms),
    });
    expect(seen).toEqual(['op-1', 'op-1']);
    expect(sleeps.length).toBe(1);
    expect(outcome.kind).toBe('settled');
  });

  it('returns deferred without looping', async () => {
    const lane = {
      drive: async (options: { operationId: string }) => ({
        ok: true as const,
        value: {
          kind: 'waiting' as const,
          operationId: options.operationId,
          reason: 'deferred' as const,
          deferred: { provider: 'faux', modelId: 'm', api: 'test', id: 'd-1' },
        },
      }),
    };
    const outcome = await driveToSettled(lane, 'op-9', BACKGROUND_CONTEXT, {
      sleep: async () => undefined,
    });
    expect(outcome.kind).toBe('waiting-deferred');
  });

  it('throws a LaneDriveError on drive failure', async () => {
    const lane = {
      drive: async (_options: { operationId: string }) => ({
        ok: false as const,
        error: { kind: 'closed' },
      }),
    };
    await expect(
      driveToSettled(lane, 'op-x', BACKGROUND_CONTEXT, {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/lane drive failed/i);
  });
});
