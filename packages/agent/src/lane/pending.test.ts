// Recovery of the work a dead process left mid-flight. A reopened Harness
// holds the unfinished tasks and submissions
// durably, `harness.inspect()` reports them, `harness.resume()` starts the
// scheduler, and the lane decides between resuming and aborting so the
// conversation is free for the next prompt. These tests drive that decision
// against real JSONL storage under a temp dir, with the faux provider and a
// tool that blocks until its invocation is cancelled; the crash is simulated by
// abandoning the first Harness mid-turn (never closing it) and reopening the
// same storage.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type Conversation,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  openNodeJsonlStorage,
  Type,
} from '../pi-boundary.js';
import { OperationKillRegistry } from './abort.js';
import {
  describePendingSettlement,
  inspectPending,
  inspectStoredWork,
  pendingInputText,
  settlePending,
} from './pending.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-pending-'));
  dirs.push(dir);
  return dir;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function toolCall(name: string, id = 'c1') {
  return fauxAssistantMessage([fauxToolCall(name, {}, { id })], {
    stopReason: 'toolUse',
  });
}

// Models, registry and faux survive a reopen, like the host process's own
// objects: the second Harness must find the same tool definition and the
// same provider.
function laneFixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  return { faux, models, registry, model: faux.getModel() };
}

// A tool whose execution blocks until its invocation's abort signal fires,
// after committing the running state (api.details) the crash test needs.
function blockingWork() {
  const started = deferred();
  const state = { runs: 0 };
  const tool = defineTool({
    name: 'work',
    description: 'block until the invocation is cancelled',
    parameters: Type.Object({}),
    execute: async (_args, api, callCtx) => {
      state.runs += 1;
      api.output(`run ${state.runs}\n`);
      await api.details({ run: state.runs }, callCtx);
      started.resolve();
      await new Promise<void>((resolve) => {
        const signal = callCtx.abortSignal;
        if (signal === undefined || signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {};
    },
  });
  return { tool, started: started.promise, state };
}

async function openLane(
  fixture: ReturnType<typeof laneFixture>,
  dir: string,
  settings?: { retry?: { enabled?: boolean } },
) {
  const storage = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
  const harness = await Harness.open(
    storage,
    {
      models: fixture.models,
      registry: fixture.registry,
      ...(settings === undefined ? {} : { settings }),
    },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: {
        provider: fixture.model.provider,
        modelId: fixture.model.id,
      },
    },
  });
  const kills = new OperationKillRegistry();
  return {
    storage,
    harness,
    conversation,
    kills,
    solo: { harness, conversation, kills },
  };
}

// Start a turn whose tool call blocks and return once the tool's running
// state is durable. The lane is left mid-turn; the caller either abandons it
// (crash) or settles it in-process.
async function blockTurn(
  lane: Awaited<ReturnType<typeof openLane>>,
  work: ReturnType<typeof blockingWork>,
  prompt = 'first task',
) {
  lane.harness.resume();
  const submission = await lane.conversation.submit(
    { type: 'input', content: prompt },
    BACKGROUND_CONTEXT,
  );
  await work.started;
  return submission;
}

async function toolResultBody(conversation: Conversation): Promise<string> {
  const entries = await conversation.entries(
    {},
    50,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const result = entries.items.find((entry) => entry.kind === 'pi.tool-result');
  return JSON.stringify(result?.model?.[0] ?? result);
}

// The guard a headless run passes: a cancellable Context bound (chord's
// Context is the structural { abortSignal, value, toString } interface, so a
// test does not need the boundary to build one).
function guard(): { context: Context; cancel: () => void } {
  const controller = new AbortController();
  return {
    context: {
      abortSignal: controller.signal,
      value: () => undefined,
      toString: () => '[test guard]',
    },
    cancel: () => controller.abort(new Error('turn budget exhausted')),
  };
}

describe('inspectPending', () => {
  it('reports nothing on a fresh session and does not start the scheduler', async () => {
    const fixture = laneFixture();
    const lane = await openLane(fixture, scratch());
    expect(await inspectPending(lane.solo, BACKGROUND_CONTEXT)).toEqual({
      pending: false,
    });
    expect((await lane.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe(
      'paused',
    );
  });

  it('reports the work a dead process left without resuming it', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('finished'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    const submission = await blockTurn(first, work);
    // `first` is abandoned, never closed: the process died mid-turn.

    const second = await openLane(fixture, dir);
    const report = await inspectPending(second.solo, BACKGROUND_CONTEXT);
    expect(report.pending).toBe(true);
    expect(report.summary).toContain('pending work:');
    expect(report.summary).toContain('pi.tool');
    expect(report.summary).toContain('pi.generation');
    expect(report.summary).toContain(`submission ${submission.id}`);
    // The probe reads, it does not resume: scheduling is still paused and
    // the tool has not been called again.
    expect((await second.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe(
      'paused',
    );
    expect(work.state.runs).toBe(1);
  });
});

describe('settlePending', () => {
  it('resume settles the interrupted turn and frees the lane', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('answered after resume'),
      fauxAssistantMessage('second reply'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    const submission = await blockTurn(first, work);
    const second = await openLane(fixture, dir);

    const settled = await settlePending(second.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: second.kills,
    });
    expect(settled).toEqual({
      outcome: 'resumed',
      fellBack: false,
      settled: 'done',
    });
    // Never-replay: the interrupted tool ran once and its durable result is
    // the interrupted error, not a rerun.
    expect(work.state.runs).toBe(1);
    expect(await toolResultBody(second.conversation)).toContain('interrupted');
    const resumedRecord = await second.harness.submission(
      submission.id,
      BACKGROUND_CONTEXT,
    );
    expect((await resumedRecord?.status(BACKGROUND_CONTEXT))?.status).toBe(
      'done',
    );
    // The lane is free: the next prompt is accepted and answered.
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('reports a resumed turn that ended unanswered, never as a clean resume', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([toolCall('work'), fauxAssistantMessage('x')]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    await blockTurn(first, work);
    // No durable retry here: the provider failure must land in one attempt.
    const second = await openLane(fixture, dir, { retry: { enabled: false } });
    fixture.faux.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'provider unavailable',
      }),
      fauxAssistantMessage('second reply'),
    ]);

    const settled = await settlePending(second.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: second.kills,
    });
    expect(settled).toEqual({
      outcome: 'resumed',
      fellBack: false,
      settled: 'unanswered',
      reason: 'model_error',
    });
    expect(describePendingSettlement('pending work: run', settled)).toBe(
      'pending work: run resumed after an interrupted run: unanswered (model_error)',
    );
    // The failed turn did not wedge the lane.
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('abort settles the interrupted turn, kills the group and frees the lane', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('second reply'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    const submission = await blockTurn(first, work);
    const second = await openLane(fixture, dir);
    // The kill a live process tracks for its bash group (keyed by the
    // conversation id, which survives the crash).
    const kill = vi.fn();
    second.kills.track(String(second.conversation.id), kill);

    const settled = await settlePending(second.solo, 'abort', {
      context: BACKGROUND_CONTEXT,
      kills: second.kills,
    });
    expect(settled).toEqual({ outcome: 'aborted', fellBack: false });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(work.state.runs).toBe(1);
    const stored = await second.harness.submission(
      submission.id,
      BACKGROUND_CONTEXT,
    );
    const record = await stored?.status(BACKGROUND_CONTEXT);
    expect(record?.status).toBe('unanswered');
    expect(record?.reason).toBe('aborted');
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('abort kills a blocked group running in this process', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('after abort'),
      fauxAssistantMessage('second reply'),
    ]);
    const lane = await openLane(fixture, scratch());
    await blockTurn(lane, work);
    const kill = vi.fn();
    lane.kills.track(String(lane.conversation.id), kill);

    const settled = await settlePending(lane.solo, 'abort', {
      context: BACKGROUND_CONTEXT,
      kills: lane.kills,
    });
    expect(settled).toEqual({ outcome: 'aborted', fellBack: false });
    // The registry drain and the aborted invocation both landed on the
    // blocked tool; it was not re-run.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(work.state.runs).toBe(1);
    expect((await lane.harness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(
      0,
    );
    const next = await lane.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('resume under an exhausted guard aborts without starting the run', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('second reply'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    const submission = await blockTurn(first, work);
    const second = await openLane(fixture, dir);
    fixture.faux.setResponses([fauxAssistantMessage('must not run')]);
    const requests = fixture.faux.state.callCount;
    const bound = guard();
    bound.cancel();
    const resume = vi.spyOn(second.harness, 'resume');

    const settled = await settlePending(second.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: second.kills,
      guard: bound.context,
    });
    expect(settled).toEqual({
      outcome: 'aborted',
      fellBack: true,
      reason: 'turn budget exhausted',
    });
    // The exhausted bound skipped harness.resume(): no scheduler, no paid
    // generation, no re-run of the interrupted tool.
    expect(resume).not.toHaveBeenCalled();
    expect(fixture.faux.state.callCount).toBe(requests);
    expect(work.state.runs).toBe(1);
    const stored = await second.harness.submission(
      submission.id,
      BACKGROUND_CONTEXT,
    );
    expect((await stored?.status(BACKGROUND_CONTEXT))?.status).toBe(
      'unanswered',
    );
    // The fallback left the lane free for the next prompt.
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('falls back to a fresh abort context when the caller context is dead', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('second reply'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    await blockTurn(first, work);
    const second = await openLane(fixture, dir);
    const bound = guard();
    bound.cancel();

    // guard === opts.context, already cancelled: pi-durable rejects a commit
    // on this context, so the abort must run on its own live context.
    const settled = await settlePending(second.solo, 'resume', {
      context: bound.context,
      kills: second.kills,
      guard: bound.context,
    });
    expect(settled).toEqual({
      outcome: 'aborted',
      fellBack: true,
      reason: 'turn budget exhausted',
    });
    // The abort committed despite the dead caller context.
    expect(
      (await second.harness.inspect(BACKGROUND_CONTEXT)).tasks,
    ).toHaveLength(0);
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('a guard that fires mid-resume aborts the pending turn and names the cause', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('after abort'),
      fauxAssistantMessage('second reply'),
    ]);
    const lane = await openLane(fixture, scratch());
    await blockTurn(lane, work);
    const bound = guard();
    const kill = vi.fn();
    lane.kills.track(String(lane.conversation.id), kill);

    const settling = settlePending(lane.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: lane.kills,
      guard: bound.context,
    });
    // Let resume() start the scheduler and register the bounded wait, then
    // exhaust the bound the way a wall-clock guard does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    bound.cancel();
    const settled = await settling;
    expect(settled).toEqual({
      outcome: 'aborted',
      fellBack: true,
      reason: 'turn budget exhausted',
    });
    expect(describePendingSettlement('pending work: run', settled)).toBe(
      'pending work: run aborted after an interrupted run (resume could not settle: turn budget exhausted)',
    );
    expect(kill).toHaveBeenCalledTimes(1);
    const next = await lane.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('honours an abort a dead process already requested', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('must not run'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    await blockTurn(first, work);
    const second = await openLane(fixture, dir);
    // The durable abort mark the dead process left: committed while the
    // scheduler is still paused, so nothing signals the blocked tool.
    const generation = (
      await second.harness.inspect(BACKGROUND_CONTEXT)
    ).tasks.find((task) => task.record.kind === 'pi.generation');
    if (generation === undefined) throw new Error('no generation task');
    await second.harness.commit(async (tx) => {
      const record = await tx.task(generation.record.id);
      if (record === undefined) throw new Error('no generation record');
      // The public Tx hides direct task writes; this is the same idiom
      // pi-durable's own recovery tests use to leave a durable abort mark.
      (tx as unknown as { setTask(value: unknown): void }).setTask({
        ...record,
        abortRequested: true,
      });
    }, BACKGROUND_CONTEXT);
    const kill = vi.fn();
    second.kills.track(String(second.conversation.id), kill);
    const requests = fixture.faux.state.callCount;

    const settled = await settlePending(second.solo, 'resume', {
      context: BACKGROUND_CONTEXT,
      kills: second.kills,
    });
    expect(settled).toEqual({ outcome: 'aborted', fellBack: false });
    // The operator's cancel was honoured: no model request, no re-run.
    expect(fixture.faux.state.callCount).toBe(requests);
    expect(work.state.runs).toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
    const next = await second.conversation.submit(
      { type: 'input', content: 'second' },
      BACKGROUND_CONTEXT,
    );
    expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe('done');
  });

  it('returns none when nothing is pending', async () => {
    const fixture = laneFixture();
    const lane = await openLane(fixture, scratch());
    for (const policy of ['resume', 'abort'] as const) {
      expect(
        await settlePending(lane.solo, policy, {
          context: BACKGROUND_CONTEXT,
          kills: lane.kills,
        }),
      ).toEqual({ outcome: 'none', fellBack: false });
    }
  });
});

describe('pendingInputText', () => {
  it('names the prompt the dead process admitted', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('finished'),
    ]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    await blockTurn(first, work, 'the interrupted prompt');
    const second = await openLane(fixture, dir);
    expect(await pendingInputText(second.solo, BACKGROUND_CONTEXT)).toBe(
      'the interrupted prompt',
    );
  });

  it('joins text parts and reports nothing without a placed input', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([
      toolCall('work'),
      fauxAssistantMessage('finished'),
    ]);
    const lane = await openLane(fixture, scratch());
    expect(
      await pendingInputText(lane.solo, BACKGROUND_CONTEXT),
    ).toBeUndefined();
    lane.harness.resume();
    await lane.conversation.submit(
      {
        type: 'input',
        content: [
          { type: 'text', text: 'new ' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
          { type: 'text', text: 'prompt' },
        ],
      },
      BACKGROUND_CONTEXT,
    );
    await work.started;
    expect(await pendingInputText(lane.solo, BACKGROUND_CONTEXT)).toBe(
      'new prompt',
    );
  });
});

// A minimal structural lane for the decision paths that need a failing wait,
// a refused abort or kill failures — cases the real harness only reaches
// through infrastructure faults.
function stubLane(options: {
  inspection: unknown;
  wait?: () => Promise<unknown>;
  idle?: () => Promise<void>;
}): {
  calls: string[];
  kills: OperationKillRegistry;
  solo: {
    harness: Harness;
    conversation: Conversation;
    kills: OperationKillRegistry;
  };
} {
  const calls: string[] = [];
  const kills = new OperationKillRegistry();
  const harness = {
    inspect: async () => options.inspection,
    resume: () => {
      calls.push('resume');
    },
    submission: async (id: number) =>
      options.wait === undefined
        ? undefined
        : { id, wait: options.wait, status: async () => ({}) },
  };
  const conversation = {
    id: 7,
    abort: async () => {
      calls.push('abort');
    },
    waitForIdle: async () => {
      calls.push('idle');
      await options.idle?.();
    },
  };
  return {
    calls,
    kills,
    solo: {
      harness: harness as unknown as Harness,
      conversation: conversation as unknown as Conversation,
      kills,
    },
  };
}

const READY_TOOL = {
  record: {
    id: 12,
    conversationId: 1,
    kind: 'pi.tool',
    version: 1,
    input: { callId: 'c1' },
    background: false,
    abortRequested: false,
    state: { status: 'pending', checkpoint: {} },
  },
  state: { kind: 'ready', migrates: false },
};
const PLACED_INPUT = {
  id: 8,
  conversationId: 1,
  type: 'input',
  status: 'placed',
  entry: 7,
};

describe('settlePending decision paths', () => {
  it('waits for a placed submission, then confirms the lane is idle', async () => {
    const wait = vi.fn(async () => ({ status: 'done' }));
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [PLACED_INPUT],
      },
      wait,
    });
    expect(
      await settlePending(lane.solo, 'resume', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).toEqual({ outcome: 'resumed', fellBack: false, settled: 'done' });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(lane.calls).toEqual(['resume', 'idle']);
  });

  it('a failing resume wait falls back to the durable abort, naming the cause', async () => {
    const kill = vi.fn();
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [PLACED_INPUT],
      },
      wait: async () => {
        throw new Error('storage exploded');
      },
    });
    lane.kills.track('7', kill);
    expect(
      await settlePending(lane.solo, 'resume', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).toEqual({
      outcome: 'aborted',
      fellBack: true,
      reason: 'storage exploded',
    });
    expect(lane.calls).toEqual(['resume', 'abort', 'idle']);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('a non-Error resume failure is named verbatim', async () => {
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [PLACED_INPUT],
      },
      wait: async () => {
        throw 'plain refusal';
      },
    });
    expect(
      await settlePending(lane.solo, 'resume', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).toEqual({
      outcome: 'aborted',
      fellBack: true,
      reason: 'plain refusal',
    });
  });

  it('an abort-marked task is aborted without resuming', async () => {
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [
          {
            ...READY_TOOL,
            record: { ...READY_TOOL.record, abortRequested: true },
          },
        ],
        submissions: [PLACED_INPUT],
      },
    });
    expect(
      await settlePending(lane.solo, 'resume', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).toEqual({ outcome: 'aborted', fellBack: false });
    expect(lane.calls).toEqual(['abort', 'idle']);
  });

  it('aborts with no submission by waiting for the conversation to go idle', async () => {
    const idle = vi.fn(async () => undefined);
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [],
      },
      idle,
    });
    expect(
      await settlePending(lane.solo, 'abort', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).toEqual({ outcome: 'aborted', fellBack: false });
    expect(lane.calls).toEqual(['abort', 'idle']);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('attempts every kill and aggregates the failures', async () => {
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [],
      },
    });
    const first = vi.fn(() => {
      throw new Error('kill EPERM');
    });
    const second = vi.fn();
    lane.kills.track('7', first);
    lane.kills.track('7', second);
    await expect(
      settlePending(lane.solo, 'abort', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).rejects.toThrow(/kills failed.*kill EPERM/);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps kill failures visible when the abort itself rejects', async () => {
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [],
      },
    });
    (
      lane.solo.conversation as unknown as {
        abort: () => Promise<void>;
      }
    ).abort = async () => {
      throw new Error('abort refused');
    };
    lane.kills.track(
      '7',
      vi.fn(() => {
        throw new Error('kill EPERM');
      }),
    );
    await expect(
      settlePending(lane.solo, 'abort', {
        context: BACKGROUND_CONTEXT,
        kills: lane.kills,
      }),
    ).rejects.toThrow(/abort refused.*kill EPERM/);
  });

  it('drains only the conversation key, never stale operation keys', async () => {
    const lane = stubLane({
      inspection: {
        scheduling: 'paused',
        tasks: [READY_TOOL],
        submissions: [],
      },
    });
    const stale = vi.fn();
    lane.kills.track('12', stale);
    lane.kills.track('c1', stale);
    await settlePending(lane.solo, 'abort', {
      context: BACKGROUND_CONTEXT,
      kills: lane.kills,
    });
    expect(stale).not.toHaveBeenCalled();
  });
});

describe('inspectStoredWork', () => {
  it('reports stored pending work without opening a harness', async () => {
    const fixture = laneFixture();
    const work = blockingWork();
    fixture.registry.install(
      defineExtension({ name: 'kubic', tools: [work.tool] }),
    );
    fixture.faux.setResponses([toolCall('work')]);
    const dir = scratch();
    const first = await openLane(fixture, dir);
    await blockTurn(first, work);

    const storage = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
    try {
      const report = await inspectStoredWork(storage, BACKGROUND_CONTEXT);
      expect(report.pending).toBe(true);
      expect(report.summary).toContain('pending work:');
      expect(report.summary).toContain('pi.tool');
      expect(report.summary).toContain('submission');
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it('reports nothing for a storage with no unfinished work', async () => {
    const fixture = laneFixture();
    const dir = scratch();
    const lane = await openLane(fixture, dir);
    lane.harness.resume();
    const submission = await lane.conversation.submit(
      { type: 'input', content: 'hello' },
      BACKGROUND_CONTEXT,
    );
    fixture.faux.setResponses([fauxAssistantMessage('hi')]);
    await submission.wait(BACKGROUND_CONTEXT);

    const storage = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
    try {
      expect(await inspectStoredWork(storage, BACKGROUND_CONTEXT)).toEqual({
        pending: false,
      });
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });
});

describe('describePendingSettlement', () => {
  it('names the pending work and what happened to it', () => {
    const head = 'pending work: pi.tool 12 (ready)';
    expect(
      describePendingSettlement(head, {
        outcome: 'resumed',
        fellBack: false,
        settled: 'done',
      }),
    ).toBe(`${head} resumed after an interrupted run: done`);
    expect(
      describePendingSettlement(head, {
        outcome: 'resumed',
        fellBack: false,
        settled: 'unanswered',
        reason: 'model_error',
      }),
    ).toBe(
      `${head} resumed after an interrupted run: unanswered (model_error)`,
    );
    expect(
      describePendingSettlement(head, { outcome: 'resumed', fellBack: false }),
    ).toBe(`${head} resumed after an interrupted run`);
    expect(
      describePendingSettlement(head, { outcome: 'aborted', fellBack: false }),
    ).toBe(`${head} aborted after an interrupted run`);
    expect(
      describePendingSettlement(head, {
        outcome: 'aborted',
        fellBack: true,
        reason: 'turn budget exhausted',
      }),
    ).toBe(
      `${head} aborted after an interrupted run (resume could not settle: turn budget exhausted)`,
    );
    expect(
      describePendingSettlement(head, { outcome: 'aborted', fellBack: true }),
    ).toBe(
      `${head} aborted after an interrupted run (resume could not settle)`,
    );
    expect(
      describePendingSettlement(undefined, {
        outcome: 'none',
        fellBack: false,
      }),
    ).toBe('no pending work to settle');
  });
});
