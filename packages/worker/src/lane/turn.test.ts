// The durable turn glue (issue #395): submit → submission.wait, and every
// way a run can end as one TurnOutcome. Faux provider only, MemoryStorage,
// zero network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemoryStorage,
  type Storage,
  withAbortSignal,
} from '../pi-boundary.js';
import { abortLane, forgetLaneKills, OperationKillRegistry } from './abort.js';
import { bootSoloLane, type SoloLane } from './solo.js';
import {
  runTurn,
  TURN_BUSY_REASON,
  turnAbort,
  turnAbortReasonOf,
  turnLaneRecord,
} from './turn.js';

const SOLOS: SoloLane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const solo of SOLOS.splice(0)) {
    await solo.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await solo.kills.drain(String(solo.conversation.id));
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
    dir: `/tmp/kubic-turn/${id}`,
    storage,
    meta: { cwd: '/ws', createdAt: new Date(0).toISOString() },
    adopt: () => storage,
    release: async () => undefined,
  };
}

type Faux = ReturnType<typeof fauxProvider>;

function catalog() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

async function boot(
  responses: Parameters<Faux['setResponses']>[0],
  env = new FakeExecutionEnv({}),
): Promise<{ solo: SoloLane; faux: Faux }> {
  const { faux, models } = catalog();
  faux.setResponses(responses);
  const session = handle();
  const solo = await bootSoloLane({
    session: session as never,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.id,
    agentId: 'root',
  });
  SOLOS.push(solo);
  return { solo, faux };
}

function userTexts(entries: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const entry of entries) {
    const model = (entry as { model?: unknown }).model;
    if (!Array.isArray(model)) continue;
    for (const message of model) {
      const typed = message as {
        role?: unknown;
        content?: unknown;
      };
      if (typed.role !== 'user') continue;
      if (typeof typed.content === 'string') texts.push(typed.content);
      else if (Array.isArray(typed.content)) {
        for (const part of typed.content) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') texts.push(text);
        }
      }
    }
  }
  return texts;
}

async function transcript(solo: SoloLane): Promise<unknown[]> {
  const page = await solo.conversation.entries(
    {},
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return [...page.items];
}

describe('runTurn on pi-durable (issue #395)', () => {
  it('settles one tool-call turn completed and reports its submission id', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'turn reads this\n');
    const { solo } = await boot(
      [
        fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('read it'),
      ],
      env,
    );
    const outcome = await runTurn(solo, 'read the file', {
      requestId: 'req-1',
      context: BACKGROUND_CONTEXT,
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.submissionId).not.toBe('');
    const entries = await transcript(solo);
    expect(JSON.stringify(entries)).toContain('turn reads this');
    // #247: ONE user entry for the prompt — submit writes pi.user itself.
    expect(
      userTexts(entries).filter((text) => text === 'read the file'),
    ).toEqual(['read the file']);
  });

  it('maps a failed generation to its §52 code and human message', async () => {
    const { solo } = await boot([]);
    const outcome = await runTurn(solo, 'go', {
      requestId: 'req-fail',
      context: BACKGROUND_CONTEXT,
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toBe('model_failed');
    expect(outcome.error).toBeTruthy();
    expect(outcome.error).not.toBe(outcome.reason);
  });

  it('refuses a busy conversation locally with whenBusy reject', async () => {
    const { solo } = await boot([() => new Promise<never>(() => undefined)]);
    const first = runTurn(solo, 'long turn', {
      requestId: 'req-long',
      context: BACKGROUND_CONTEXT,
    });
    // The first turn is admitted and placed; the second is refused by the
    // conversation, not queued.
    await vi.waitFor(async () => {
      const inspection = await solo.harness.inspect(BACKGROUND_CONTEXT);
      expect(inspection.submissions.length).toBeGreaterThan(0);
    });
    const busy = await runTurn(solo, 'second', {
      requestId: 'req-busy',
      context: BACKGROUND_CONTEXT,
      whenBusy: 'reject',
    });
    expect(busy).toMatchObject({
      kind: 'failed',
      reason: TURN_BUSY_REASON,
    });
    if (busy.kind !== 'failed') throw new Error('unreachable');
    expect(busy.error).toMatch(/busy/i);
    await abortLane(solo, BACKGROUND_CONTEXT);
    await first.catch(() => undefined);
  });

  it('maps a cancelled guard to aborted/guard', async () => {
    const { solo } = await boot([() => new Promise<never>(() => undefined)]);
    const controller = new AbortController();
    const pending = runTurn(solo, 'never answers', {
      requestId: 'req-guard',
      context: withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    });
    controller.abort(turnAbort('guard', 'run timed out after 5ms'));
    await expect(pending).resolves.toEqual({
      kind: 'aborted',
      reason: 'guard',
    });
    await abortLane(solo, BACKGROUND_CONTEXT);
  });

  it('maps a conversation abort to aborted/user and keeps the abort reason', async () => {
    const { solo } = await boot([() => new Promise<never>(() => undefined)]);
    const pending = runTurn(solo, 'never answers', {
      requestId: 'req-user',
      context: BACKGROUND_CONTEXT,
    });
    await vi.waitFor(async () => {
      expect(
        (await solo.harness.inspect(BACKGROUND_CONTEXT)).submissions.length,
      ).toBeGreaterThan(0);
    });
    await abortLane(solo, BACKGROUND_CONTEXT);
    await expect(pending).resolves.toEqual({ kind: 'aborted', reason: 'user' });
  });

  it('submits once for one requestId (idempotent retry)', async () => {
    const { solo } = await boot([
      fauxAssistantMessage('first answer'),
      fauxAssistantMessage('second answer'),
    ]);
    const first = await runTurn(solo, 'same prompt', {
      requestId: 'stable-id',
      context: BACKGROUND_CONTEXT,
    });
    const second = await runTurn(solo, 'same prompt', {
      requestId: 'stable-id',
      context: BACKGROUND_CONTEXT,
    });
    expect(first).toEqual(second);
    expect(userTexts(await transcript(solo))).toHaveLength(1);
  });
});

describe('turnLaneRecord (D6.1)', () => {
  it('maps completed, failed and aborted to the lane record', () => {
    expect(turnLaneRecord({ kind: 'completed', submissionId: 's-1' })).toEqual({
      status: 'completed',
    });
    expect(
      turnLaneRecord({ kind: 'failed', reason: 'model_failed', error: 'boom' }),
    ).toEqual({
      status: 'failed',
      error: { code: 'model_failed', message: 'boom' },
    });
    expect(turnLaneRecord({ kind: 'failed', reason: 'tool_failed' })).toEqual({
      status: 'failed',
      error: { code: 'tool_failed', message: 'tool_failed' },
    });
    expect(turnLaneRecord({ kind: 'aborted', reason: 'signal' })).toEqual({
      status: 'aborted',
    });
  });

  it('reads the abort marker only from a TurnAbort', () => {
    expect(turnAbortReasonOf(turnAbort('signal', 'SIGINT'))).toBe('signal');
    expect(turnAbortReasonOf(new Error('plain'))).toBeUndefined();
  });
});

describe('abortLane (D6.2)', () => {
  function laneStub(abort: (context: Context) => Promise<void>) {
    const kills = new OperationKillRegistry();
    return {
      kills,
      conversation: { id: 'conv-1', abort },
    } as never as {
      kills: OperationKillRegistry;
      conversation: { id: string; abort: (c: Context) => Promise<void> };
    };
  }

  it('aborts the conversation and runs every tracked kill', async () => {
    const aborted: string[] = [];
    const lane = laneStub(async () => {
      aborted.push('conversation');
    });
    const order: string[] = [];
    lane.kills.track('conv-1', () => order.push('kill-1'));
    lane.kills.track('conv-1', () => {
      order.push('kill-2');
      throw new Error('already gone');
    });
    await expect(abortLane(lane, BACKGROUND_CONTEXT)).rejects.toThrow(
      /lane abort failed for conv-1: already gone/,
    );
    expect(aborted).toEqual(['conversation']);
    expect(order).toEqual(['kill-1', 'kill-2']);
    expect(lane.kills.drain('conv-1')).toEqual([]);
  });

  it('reports a refused abort but still runs the kills', async () => {
    const lane = laneStub(async () => {
      throw new Error('context cancelled');
    });
    let killed = 0;
    lane.kills.track('conv-1', () => {
      killed += 1;
    });
    await expect(abortLane(lane, BACKGROUND_CONTEXT)).rejects.toThrow(
      /lane abort failed: context cancelled/,
    );
    expect(killed).toBe(1);
  });

  it('reports the killed count on a clean abort', async () => {
    const lane = laneStub(async () => undefined);
    lane.kills.track('conv-1', () => undefined);
    lane.kills.track('conv-1', () => undefined);
    await expect(abortLane(lane, BACKGROUND_CONTEXT)).resolves.toEqual({
      killed: 2,
    });
  });

  it('forgetLaneKills drops the handles without running them', () => {
    const lane = laneStub(async () => undefined);
    let killed = 0;
    lane.kills.track('conv-1', () => {
      killed += 1;
    });
    forgetLaneKills(lane);
    expect(killed).toBe(0);
    expect(lane.kills.drain('conv-1')).toEqual([]);
  });
});
