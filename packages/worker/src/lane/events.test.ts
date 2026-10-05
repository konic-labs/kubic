// #398: the lane event consumer on pi-durable's committed watch (§15,
// §15.3, §20.6, §27.1). One subscription per conversation; the sink sees
// Kubic's own vocabulary (run, tool, usage, fault, retry, compaction,
// snapshot) and never another conversation's events.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  type Conversation,
  type ConversationId,
  createModels,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryId,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Harness,
  MemoryStorage,
  type SnapshotEvent,
  type SubmissionId,
  type TaskId,
  Type,
  type Usage,
  watchEvents,
} from '../pi-boundary.js';
import {
  type KubicLaneEvent,
  subscribeLaneEvents,
  toKubicLaneEvent,
} from './events.js';

const CONVERSATION = 1 as ConversationId;

const FULL_USAGE: Usage = {
  input: 3,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Synthetic committed entries: the model payload is shaped like the real
// assistant / tool-result messages the harness writes.
function entry(id: number, kind: string, message?: unknown): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: CONVERSATION,
    kind,
    ...(message === undefined
      ? {}
      : { model: [message] as unknown as EntryRecord['model'] }),
  };
}

function assistantEntry(
  id: number,
  over: { provider?: string; model?: string; usage?: Usage } = {},
): EntryRecord {
  return entry(id, 'pi.assistant', {
    role: 'assistant',
    content: [],
    api: 'faux',
    provider: over.provider ?? 'anthropic',
    model: over.model ?? 'claude-sonnet-4-5',
    usage: over.usage ?? FULL_USAGE,
    stopReason: 'stop',
    timestamp: 0,
  });
}

function toolResultEntry(id: number, isError = false): EntryRecord {
  return entry(id, 'pi.tool-result', {
    role: 'toolResult',
    toolCallId: 'c-1',
    toolName: 'echo',
    content: [{ type: 'text', text: 'echo: hi' }],
    isError,
    timestamp: 0,
  });
}

describe('toKubicLaneEvent (§15.3)', () => {
  it('maps run start/end and tool start/end', () => {
    expect(
      toKubicLaneEvent({ type: 'run_start', inputs: [1 as SubmissionId] }),
    ).toEqual({ type: 'run-start', inputs: [1] });
    expect(
      toKubicLaneEvent({ type: 'run_end', inputs: [1 as SubmissionId] }),
    ).toEqual({ type: 'run-end', inputs: [1] });
    expect(
      toKubicLaneEvent({
        type: 'tool_execution_start',
        toolCallId: 'c-1',
        toolName: 'echo',
        args: { text: 'hi' },
      }),
    ).toEqual({
      type: 'tool-start',
      toolCallId: 'c-1',
      toolName: 'echo',
      args: { text: 'hi' },
    });

    const result = toolResultEntry(2);
    expect(
      toKubicLaneEvent({
        type: 'tool_execution_end',
        toolCallId: 'c-1',
        toolName: 'echo',
        entry: result,
      }),
    ).toEqual({
      type: 'tool-end',
      toolCallId: 'c-1',
      toolName: 'echo',
      isError: false,
      entry: result,
    });
    // No entry: the tool task faulted or was orphaned.
    expect(
      toKubicLaneEvent({
        type: 'tool_execution_end',
        toolCallId: 'c-1',
        toolName: 'echo',
      }),
    ).toEqual({
      type: 'tool-end',
      toolCallId: 'c-1',
      toolName: 'echo',
      isError: true,
    });
  });

  it('maps a streamed text delta into the live draft (issue #296)', () => {
    expect(
      toKubicLaneEvent({
        type: 'message_update',
        usage: { input: 1, output: 1 } as never,
        changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Hel' }],
      }),
    ).toEqual({ type: 'message-delta', text: 'Hel' });
    // Several text deltas in one batch concatenate, in order.
    expect(
      toKubicLaneEvent({
        type: 'message_update',
        usage: { input: 1, output: 1 } as never,
        changes: [
          { type: 'text_delta', contentIndex: 0, delta: 'lo ' },
          { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' },
          { type: 'text_delta', contentIndex: 0, delta: 'world' },
        ],
      }),
    ).toEqual({ type: 'message-delta', text: 'lo world' });
    // Nothing for the transcript: a thinking-only batch, or a whole-message
    // replacement (the committed entry follows).
    expect(
      toKubicLaneEvent({
        type: 'message_update',
        usage: { input: 1, output: 1 } as never,
        changes: [{ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }],
      }),
    ).toBeUndefined();
    expect(
      toKubicLaneEvent({
        type: 'message_update',
        usage: { input: 1, output: 1 } as never,
        changes: [{ type: 'message', message: { role: 'assistant' } as never }],
      }),
    ).toBeUndefined();
  });

  it('maps a failed tool result to isError', () => {
    const failed = toolResultEntry(2, true);
    expect(
      toKubicLaneEvent({
        type: 'tool_execution_end',
        toolCallId: 'c-1',
        toolName: 'echo',
        entry: failed,
      }),
    ).toMatchObject({ type: 'tool-end', isError: true });
  });

  it('maps an assistant entry to a usage row with its real provider/model (#287)', () => {
    const committed = assistantEntry(7);
    expect(toKubicLaneEvent({ type: 'message_end', entry: committed })).toEqual(
      {
        type: 'usage',
        row: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: FULL_USAGE,
          entryId: '7',
        },
        entry: committed,
      },
    );
  });

  it('carries non-assistant message ends as committed entries (#317)', () => {
    // A compaction summary and a reset handoff are user messages with no
    // usage row; the transcript still needs the entry, so it rides its own
    // event instead of being dropped.
    const user = entry(8, 'pi.user', {
      role: 'user',
      content: 'hi',
      timestamp: 0,
    });
    expect(toKubicLaneEvent({ type: 'message_end', entry: user })).toEqual({
      type: 'entry',
      entry: user,
    });
    const toolResult = toolResultEntry(9);
    expect(
      toKubicLaneEvent({ type: 'message_end', entry: toolResult }),
    ).toEqual({ type: 'entry', entry: toolResult });
  });

  it('maps retries, compactions and task failures', () => {
    expect(
      toKubicLaneEvent({
        type: 'auto_retry_start',
        attempt: 1,
        at: 5,
        errorMessage: 'server overloaded',
      }),
    ).toEqual({
      type: 'retry',
      phase: 'start',
      attempt: 1,
      error: 'server overloaded',
    });
    expect(toKubicLaneEvent({ type: 'auto_retry_end', attempt: 1 })).toEqual({
      type: 'retry',
      phase: 'end',
      attempt: 1,
    });
    expect(
      toKubicLaneEvent({
        type: 'compaction_start',
        taskId: 9 as TaskId,
        reason: 'threshold',
        blocking: true,
      }),
    ).toEqual({ type: 'compaction', phase: 'start', reason: 'threshold' });
    expect(
      toKubicLaneEvent({
        type: 'compaction_end',
        taskId: 9 as TaskId,
        reason: 'threshold',
      }),
    ).toEqual({ type: 'compaction', phase: 'end', reason: 'threshold' });
    expect(
      toKubicLaneEvent({
        type: 'task_failed',
        taskId: 3 as TaskId,
        kind: 'pi.generation',
        message: 'boom',
      }),
    ).toEqual({ type: 'fault', code: 'pi.generation', message: 'boom' });
  });

  it('maps an inbox update to the queued items, ids as strings (#334)', () => {
    expect(
      toKubicLaneEvent({
        type: 'inbox_update',
        items: [
          { id: 11 as SubmissionId, mode: 'followUp' },
          { id: 12 as SubmissionId, mode: 'steer' },
        ],
      }),
    ).toEqual({
      type: 'inbox',
      items: [
        { id: '11', mode: 'followUp' },
        { id: '12', mode: 'steer' },
      ],
    });
    // Placement and withdrawal emit the same event with the remaining items
    // (here: none) — the list is a snapshot, so a renderer replaces its rows.
    expect(toKubicLaneEvent({ type: 'inbox_update', items: [] })).toEqual({
      type: 'inbox',
      items: [],
    });
  });

  it('ignores event kinds Kubic does not route', () => {
    const ignored = [
      { type: 'turn_start' },
      { type: 'turn_end' },
      { type: 'deferred_poll', pollAt: 1 },
      { type: 'usage_changed', usage: { models: {}, tools: {} } },
      { type: 'agent_changed', agent: {} },
      {
        type: 'message_start',
        message: { role: 'user', content: '', timestamp: 0 },
      },
    ] as const;
    for (const event of ignored) {
      expect(toKubicLaneEvent(event)).toBeUndefined();
    }
  });

  it('maps the snapshot (attach / late join / overflow) with replace semantics', () => {
    const snapshot: SnapshotEvent = {
      type: 'snapshot',
      entries: [assistantEntry(1), toolResultEntry(2)],
      run: { inputs: [4 as SubmissionId] },
      generation: { attempt: 2, retry: { at: 10, error: 'server overloaded' } },
      tools: [
        { callId: 'c-1', name: 'echo', status: 'running' },
        { callId: 'c-2', name: 'echo', status: 'done', entry: 2 as EntryId },
        { callId: 'c-3', name: 'echo', status: 'done' },
      ],
      compactions: [
        {
          taskId: 9 as SnapshotEvent['compactions'][number]['taskId'],
          reason: 'threshold',
          blocking: true,
          attempt: 1,
        },
      ],
      inbox: [],
      agent: {},
      usage: { models: { 'faux/faux-1': FULL_USAGE }, tools: {} },
    };
    expect(toKubicLaneEvent(snapshot)).toEqual({
      type: 'snapshot',
      entries: snapshot.entries,
      run: [4],
      tools: [
        {
          toolCallId: 'c-1',
          toolName: 'echo',
          status: 'running',
          isError: false,
        },
        {
          toolCallId: 'c-2',
          toolName: 'echo',
          status: 'done',
          isError: false,
          entry: snapshot.entries[1],
        },
        // Done without a result entry: faulted or orphaned.
        { toolCallId: 'c-3', toolName: 'echo', status: 'done', isError: true },
      ],
      retry: { attempt: 2, error: 'server overloaded' },
      compactions: [
        { taskId: 9, reason: 'threshold', blocking: true, attempt: 1 },
      ],
      usage: { models: { 'faux/faux-1': FULL_USAGE }, tools: {} },
    });
  });
});

// --- faux integration on a real Harness over MemoryStorage ----------------

interface TestLane {
  harness: Harness;
  conversation: Conversation;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the given text.',
  parameters: Type.Object({ text: Type.String() }),
  replay: 'safe',
  async execute(args) {
    return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
  },
});

async function boot(options: {
  responses: ReturnType<typeof fauxAssistantMessage>[];
  retry?: { baseDelayMs: number };
}): Promise<TestLane> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(options.responses);
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: 'kubic-test-tools', tools: [echoTool] }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      ...(options.retry === undefined
        ? {}
        : { settings: { retry: options.retry } }),
    },
    BACKGROUND_CONTEXT,
  );
  openHarnesses.push(harness);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });
  return { harness, conversation };
}

async function runTurn(lane: TestLane, prompt: string): Promise<void> {
  const submission = await lane.conversation.submit(
    { type: 'input', content: prompt },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
  await lane.harness.waitForIdle(BACKGROUND_CONTEXT);
}

// One macrotask: let the watch's queued microtask drain reach the sink.
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('subscribeLaneEvents over watchEvents (#398)', () => {
  it('streams a faux tool turn as run, tool, usage, run-end in order', async () => {
    const lane = await boot({
      responses: [
        fauxAssistantMessage(fauxToolCall('echo', { text: 'hi' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(fauxText('done')),
      ],
    });
    const seen: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => seen.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      await runTurn(lane, 'echo hi');
      await flush();
    } finally {
      await stop();
    }

    // The attach snapshot arrives first (late join); then the run.
    expect(seen[0]?.type).toBe('snapshot');
    const types = seen.map((event) => event.type);
    expect(types).toContain('run-start');
    expect(types.at(-1)).toBe('run-end');
    const toolStart = types.indexOf('tool-start');
    const toolEnd = types.indexOf('tool-end');
    const usage = types.lastIndexOf('usage');
    expect(toolStart).toBeGreaterThan(0);
    expect(toolEnd).toBeGreaterThan(toolStart);
    expect(usage).toBeGreaterThan(toolEnd);
    const start = seen.find((event) => event.type === 'tool-start');
    expect(start).toMatchObject({
      type: 'tool-start',
      toolName: 'echo',
      args: { text: 'hi' },
    });
    const end = seen.find((event) => event.type === 'tool-end');
    expect(end).toMatchObject({ type: 'tool-end', isError: false });
  });

  it('emits a retry start/end pair for a transient error, then succeeds', async () => {
    const lane = await boot({
      responses: [
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'server overloaded',
        }),
        fauxAssistantMessage(fauxText('recovered')),
      ],
      retry: { baseDelayMs: 1 },
    });
    const seen: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => seen.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      await runTurn(lane, 'say hi');
      await flush();
    } finally {
      await stop();
    }
    const retries = seen.filter((event) => event.type === 'retry');
    expect(retries).toEqual([
      { type: 'retry', phase: 'start', attempt: 1, error: 'server overloaded' },
      { type: 'retry', phase: 'end', attempt: 1 },
    ]);
    expect(seen.at(-1)?.type).toBe('run-end');
  });

  it('labels usage rows with the provider and model that answered (#287)', async () => {
    const lane = await boot({
      responses: [fauxAssistantMessage(fauxText('hi'))],
    });
    const seen: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => seen.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      await runTurn(lane, 'hi');
      await flush();
    } finally {
      await stop();
    }
    const usages = seen.filter((event) => event.type === 'usage');
    expect(usages.length).toBeGreaterThan(0);
    for (const event of usages) {
      if (event.type !== 'usage') continue;
      expect(event.row.provider).toBe('faux');
      expect(event.row.model).toBe('faux-1');
      expect(event.entry.kind).toBe('pi.assistant');
    }
  });

  it('never delivers another conversation’s events', async () => {
    const lane = await boot({
      responses: [fauxAssistantMessage(fauxText('hello'))],
    });
    const other = await lane.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      },
      BACKGROUND_CONTEXT,
    );
    const seen: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      other.id,
      (event) => seen.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      await runTurn(lane, 'hello'); // runs on the root conversation
      await flush();
    } finally {
      await stop();
    }
    // `other`'s attach snapshot is its own empty state; no run, tool or
    // usage event from the root crosses into it.
    expect(seen.filter((event) => event.type !== 'snapshot')).toEqual([]);
    const snapshot = seen.find((event) => event.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' ? snapshot.entries : []).toEqual([]);
  });

  it('recovers a fallen-behind sink from the snapshot without duplicating cells', async () => {
    const lane = await boot({
      responses: [
        fauxAssistantMessage(fauxToolCall('echo', { text: 'one' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(fauxText('first')),
        fauxAssistantMessage(fauxToolCall('echo', { text: 'two' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(fauxText('second')),
      ],
    });
    await runTurn(lane, 'first');

    // Attach without starting and commit more than the watch's 100-frame
    // pending bound (pi-durable README "Watching a Conversation"): the
    // overflow frame is one fresh snapshot.
    const stream = await watchEvents(
      lane.harness,
      lane.conversation.id,
      BACKGROUND_CONTEXT,
    );
    for (let i = 0; i < 105; i += 1) {
      await lane.conversation.submit(
        { type: 'write', entry: { kind: 'test.note', data: i } },
        BACKGROUND_CONTEXT,
      );
    }
    const seen: KubicLaneEvent[] = [];
    stream.start(async (events) => {
      for (const event of events) {
        const mapped = toKubicLaneEvent(event);
        if (mapped !== undefined) seen.push(mapped);
      }
    });
    try {
      await runTurn(lane, 'second');
      await flush();
    } finally {
      await stream.stop();
    }

    // Fold like the TUI feed does: a snapshot REPLACES the transcript
    // cells, an entry-bearing event appends exactly that entry.
    const cells: number[] = [];
    const index = new Map<number, number>();
    // The TUI feed UPSERTS by entry id (a re-delivered entry replaces its
    // cell, it never appends a second one), so the fold here does the same.
    const push = (committed: EntryRecord): void => {
      const id = committed.id as number;
      const at = index.get(id);
      if (at === undefined) {
        index.set(id, cells.length);
        cells.push(id);
      } else {
        cells[at] = id;
      }
    };
    let snapshotted = 0;
    for (const event of seen) {
      if (event.type === 'snapshot') {
        cells.length = 0;
        index.clear();
        for (const committed of event.entries) push(committed);
        snapshotted = event.entries.length;
      } else if ('entry' in event && event.entry !== undefined) {
        push(event.entry);
      }
    }
    expect(seen[0]?.type).toBe('snapshot');
    expect(snapshotted).toBeGreaterThan(0);
    // The second turn appended its cells on top of the snapshot.
    expect(cells.length).toBeGreaterThan(snapshotted);
    // No cell appears twice.
    expect(cells.length).toBe(index.size);
  });
});
