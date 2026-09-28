import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemorySessionRepo,
  type OperationResultRecord,
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
  it('boots one lane with the 15 Kubic tools and no IPC', async () => {
    const createSpy = vi.spyOn(AgentHarness, 'create');
    let booted: Awaited<ReturnType<typeof boot>>;
    try {
      booted = await boot('hi');
      // In-process: the lane's harness is the one Pi's AgentHarness.create
      // built in this process — no IPC proxy in between.
      expect(createSpy).toHaveBeenCalledTimes(1);
      const created = await createSpy.mock.results[0]?.value;
      expect(booted.harness).toBe(created.harness);
    } finally {
      createSpy.mockRestore();
    }
    const { harness } = booted;
    const tools = await harness.getTools(BACKGROUND_CONTEXT);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bash',
      'edit',
      'find',
      'git_branch',
      'git_checkpoint',
      'git_commit',
      'git_diff',
      'git_log',
      'git_show',
      'git_stage',
      'git_status',
      'grep',
      'ls',
      'read',
      'write',
    ]);
  });

  it('drives a faux text turn to settled', async () => {
    const { lane } = await boot('all done here');
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
    if (outcome.kind === 'settled') {
      expect((outcome.outcome as OperationResultRecord).status).toBe(
        'completed',
      );
    }
    const entries = await lane.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).toContain('all done here');
  });

  it('executes a Kubic op for a faux tool call', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'lane reads this\n');
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
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
  });
});

describe('driveToSettled outcome routing (issue #11, slice A)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for notBefore on retry then drives again', async () => {
    // Frozen clock: the sleep must be exactly notBefore - now.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
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
              notBefore: 10_050,
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
    expect(sleeps).toEqual([50]);
    expect(outcome).toEqual({ kind: 'settled', outcome: { marker: true } });
  });

  it('returns deferred without looping', async () => {
    let drives = 0;
    const sleeps: number[] = [];
    const deferred = { provider: 'faux', modelId: 'm', api: 'test', id: 'd-1' };
    const lane = {
      drive: async (options: { operationId: string }) => {
        drives += 1;
        return {
          ok: true as const,
          value: {
            kind: 'waiting' as const,
            operationId: options.operationId,
            reason: 'deferred' as const,
            deferred,
          },
        };
      },
    };
    const outcome = await driveToSettled(lane, 'op-9', BACKGROUND_CONTEXT, {
      sleep: async (ms: number) => void sleeps.push(ms),
    });
    expect(outcome).toEqual({
      kind: 'waiting-deferred',
      operationId: 'op-9',
      deferred,
    });
    // Deferred hands control back: one drive, no sleep, no retry loop.
    expect(drives).toBe(1);
    expect(sleeps).toEqual([]);
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
