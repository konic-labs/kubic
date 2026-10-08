// The durable turn glue: submit → submission.wait, and every
// way a run can end as one TurnOutcome. Faux provider only, MemoryStorage,
// zero network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecutionEnv,
  FakeExecutionEnv,
  type Shell,
} from '../../../exec/src/env.js';
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
import type { AbortableLane } from './abort.js';
import { abortLane, forgetLaneKills, OperationKillRegistry } from './abort.js';
import { type KubicLaneEvent, subscribeLaneEvents } from './events.js';
import { bootLane, type Lane } from './solo.js';
import { entriesToTranscript, readConversationEntries } from './transcript.js';
import {
  runTurn,
  TURN_BUSY_REASON,
  turnAbort,
  turnAbortReasonOf,
  turnLaneRecord,
} from './turn.js';

const LANES: Lane[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lane of LANES.splice(0)) {
    await lane.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await lane.kills.drain(String(lane.conversation.id));
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
  env: ExecutionEnv = new FakeExecutionEnv({}),
  extra: Partial<Parameters<typeof bootLane>[0]> = {},
): Promise<{ lane: Lane; faux: Faux }> {
  const { faux, models } = catalog();
  faux.setResponses(responses);
  const session = handle();
  const lane = await bootLane({
    session: session as never,
    models,
    model: faux.getModel(),
    env,
    sessionId: session.id,
    agentId: 'root',
    ...extra,
  });
  LANES.push(lane);
  return { lane, faux };
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

async function transcript(lane: Lane): Promise<unknown[]> {
  const page = await lane.conversation.entries(
    {},
    200,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return [...page.items];
}

describe('runTurn on pi-durable', () => {
  it('settles one tool-call turn completed and reports its submission id', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'turn reads this\n');
    const { lane } = await boot(
      [
        fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('read it'),
      ],
      env,
    );
    const admissions: string[] = [];
    const outcome = await runTurn(lane, 'read the file', {
      requestId: 'req-1',
      context: BACKGROUND_CONTEXT,
      onSubmitted: (_id, state) => admissions.push(state),
    });
    // An idle submit is placed at once: the TUI's busy latch stays on.
    expect(admissions).toEqual(['placed']);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.submissionId).not.toBe('');
    const entries = await transcript(lane);
    expect(JSON.stringify(entries)).toContain('turn reads this');
    // ONE user entry for the prompt — submit writes pi.user itself.
    expect(
      userTexts(entries).filter((text) => text === 'read the file'),
    ).toEqual(['read the file']);
  });

  it('maps a failed generation to its failure code and human message', async () => {
    const { lane } = await boot([]);
    const outcome = await runTurn(lane, 'go', {
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
    const { lane } = await boot([() => new Promise<never>(() => undefined)]);
    const first = runTurn(lane, 'long turn', {
      requestId: 'req-long',
      context: BACKGROUND_CONTEXT,
    });
    // The first turn is admitted and placed; the second is refused by the
    // conversation, not queued.
    await vi.waitFor(async () => {
      const inspection = await lane.harness.inspect(BACKGROUND_CONTEXT);
      expect(inspection.submissions.length).toBeGreaterThan(0);
    });
    const busy = await runTurn(lane, 'second', {
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
    await abortLane(lane, BACKGROUND_CONTEXT);
    await first.catch(() => undefined);
  });

  it('queues a busy follow-up, reports its id, and delivers it after settlement', async () => {
    let admitted: () => void = () => {};
    const landed = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lane } = await boot([
      async () => {
        admitted();
        await gate;
        return fauxAssistantMessage('first answer');
      },
      fauxAssistantMessage('second answer'),
    ]);
    const first = runTurn(lane, 'first prompt', {
      requestId: 'req-first',
      context: BACKGROUND_CONTEXT,
    });
    await landed;
    const ids: string[] = [];
    const admissions: string[] = [];
    const second = runTurn(lane, 'second prompt', {
      requestId: 'req-second',
      context: BACKGROUND_CONTEXT,
      whenBusy: 'followUp',
      onSubmitted: (id, state) => {
        ids.push(id);
        admissions.push(state);
      },
    });
    // The busy Enter is ADMITTED at once (never refused): the id lands while
    // the first run is still in flight, and the item sits queued in the
    // conversation's own inbox (the queue is pi-durable's, not a
    // Kubic-owned list).
    await vi.waitFor(() => expect(ids).toHaveLength(1));
    expect(ids[0]).not.toBe('');
    // The admission answer is what the TUI's busy latch reads: a queued
    // follow-up is not placed work.
    expect(admissions).toEqual(['queued']);
    const queued = await lane.harness.inspect(BACKGROUND_CONTEXT);
    expect(
      queued.submissions.find((row) => String(row.id) === ids[0]),
    ).toMatchObject({ status: 'queued' });
    const inbox = await lane.conversation.viewState(BACKGROUND_CONTEXT);
    expect(JSON.stringify(inbox.value.docs['pi.inbox'])).toContain(
      '"mode":"followUp"',
    );
    // Nothing of the queued prompt is in the transcript yet.
    expect(userTexts(await transcript(lane))).toEqual(['first prompt']);
    release();
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
    // The harness places the follow-up when the run answers and starts the
    // next run with it: the same settlement path as any other submit.
    await expect(second).resolves.toMatchObject({ kind: 'completed' });
    const texts = userTexts([...(await transcript(lane))].reverse());
    expect(texts).toEqual(['first prompt', 'second prompt']);
    expect(JSON.stringify(await transcript(lane))).toContain('second answer');
  });

  it('places a busy steer on the running operation, never as a queued turn', async () => {
    // The shell answers never matter (the round stays gated); opt out of
    // strict mode explicitly.
    const base = new FakeExecutionEnv({}, { allowUnscripted: true });
    base.fs.writeFile('a.txt', 'steer me\n');
    let toolStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let releaseTool: () => void = () => {};
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    // A bash round that stays in flight until the test releases it: the
    // steer below lands INSIDE that tool round's turn.
    const gatedShell: Shell = {
      spawn: (cmd, args, options) => {
        const handle = base.shell.spawn(cmd, args, options);
        return {
          ...handle,
          wait: async () => {
            toolStarted();
            await toolGate;
            return handle.wait();
          },
        };
      },
    };
    const env: ExecutionEnv = {
      cwd: base.cwd,
      fs: base.fs,
      provenance: base.provenance,
      shell: gatedShell,
      withProvenance: (next) => ({ ...env, provenance: next }),
    };
    const seen: string[] = [];
    const { lane } = await boot(
      [
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], {
          stopReason: 'toolUse',
        }),
        (context) => {
          seen.push(context.messages.map((m) => JSON.stringify(m)).join('\n'));
          return fauxAssistantMessage('steered answer');
        },
      ],
      env,
    );
    const first = runTurn(lane, 'first prompt', {
      requestId: 'req-first',
      context: BACKGROUND_CONTEXT,
    });
    await started;
    const ids: string[] = [];
    const steered = runTurn(lane, 'prefer pnpm', {
      requestId: 'req-steer',
      context: BACKGROUND_CONTEXT,
      whenBusy: 'steer',
      onSubmitted: (id) => ids.push(id),
    });
    await vi.waitFor(() => expect(ids).toHaveLength(1));
    const inbox = await lane.conversation.viewState(BACKGROUND_CONTEXT);
    expect(JSON.stringify(inbox.value.docs['pi.inbox'])).toContain(
      '"mode":"steer"',
    );
    releaseTool();
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
    await expect(steered).resolves.toMatchObject({ kind: 'completed' });
    // The steer joined the RUNNING work: the model request that followed the
    // tool round carried it as a user message, in the same turn.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('prefer pnpm');
  });

  it('maps a cancelled guard to aborted/guard', async () => {
    const { lane } = await boot([() => new Promise<never>(() => undefined)]);
    const controller = new AbortController();
    const pending = runTurn(lane, 'never answers', {
      requestId: 'req-guard',
      context: withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    });
    controller.abort(turnAbort('guard', 'run timed out after 5ms'));
    await expect(pending).resolves.toEqual({
      kind: 'aborted',
      reason: 'guard',
    });
    await abortLane(lane, BACKGROUND_CONTEXT);
  });

  it('maps a conversation abort to aborted/user and keeps the abort reason', async () => {
    const { lane } = await boot([() => new Promise<never>(() => undefined)]);
    const pending = runTurn(lane, 'never answers', {
      requestId: 'req-user',
      context: BACKGROUND_CONTEXT,
    });
    await vi.waitFor(async () => {
      expect(
        (await lane.harness.inspect(BACKGROUND_CONTEXT)).submissions.length,
      ).toBeGreaterThan(0);
    });
    await abortLane(lane, BACKGROUND_CONTEXT);
    await expect(pending).resolves.toEqual({ kind: 'aborted', reason: 'user' });
  });

  it('submits once for one requestId (idempotent retry)', async () => {
    const { lane } = await boot([
      fauxAssistantMessage('first answer'),
      fauxAssistantMessage('second answer'),
    ]);
    const first = await runTurn(lane, 'same prompt', {
      requestId: 'stable-id',
      context: BACKGROUND_CONTEXT,
    });
    const second = await runTurn(lane, 'same prompt', {
      requestId: 'stable-id',
      context: BACKGROUND_CONTEXT,
    });
    expect(first).toEqual(second);
    expect(userTexts(await transcript(lane))).toHaveLength(1);
  });
});

describe('durable retry', () => {
  it('retries a transient provider error inside the harness, with no Kubic sleep', async () => {
    const { lane, faux } = await boot(
      [
        fauxAssistantMessage('failed attempt', {
          stopReason: 'error',
          errorMessage: 'server error 500',
        }),
        fauxAssistantMessage('recovered'),
      ],
      new FakeExecutionEnv({}),
      // The delay is the harness's; a test does not want to wait out the
      // shipped 2 s backoff to prove the retry happened.
      { settings: { retry: { baseDelayMs: 1 } } },
    );
    const events: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => events.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      const outcome = await runTurn(lane, 'try again', {
        requestId: 'retry-1',
        context: BACKGROUND_CONTEXT,
      });
      expect(outcome.kind).toBe('completed');
      // Both attempts hit the provider, and the retry is visible in the
      // lane's own events, not in a Kubic sleep loop.
      expect(faux.state.callCount).toBe(2);
      const starts = events.filter(
        (event) => event.type === 'retry' && event.phase === 'start',
      );
      expect(starts).toHaveLength(1);
      expect(
        starts[0]?.type === 'retry' ? starts[0].error : undefined,
      ).toContain('500');
      const assistant = (
        await entriesToTranscript(
          await readConversationEntries(lane.conversation, BACKGROUND_CONTEXT),
        )
      ).filter((item) => item.kind === 'assistant');
      // The failed attempt is committed (it spent tokens) and the answer is
      // the SECOND response.
      expect(assistant.map((item) => item.text)).toEqual([
        'failed attempt',
        'recovered',
      ]);
    } finally {
      await stop();
    }
  });
});

describe('turnLaneRecord', () => {
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

describe('abortLane', () => {
  function laneStub(abort: (context: Context) => Promise<void>): AbortableLane {
    const kills = new OperationKillRegistry();
    return {
      kills,
      conversation: { id: 'conv-1', abort },
    } as unknown as AbortableLane;
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
