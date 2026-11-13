// The lane event consumer on pi-durable's conversation view. One subscription
// per conversation; the sink sees Kubic's own vocabulary (run, tool, usage,
// fault, retry, compaction, snapshot) and never another conversation's state.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTEXT,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ConversationView,
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
  type InboxState,
  type LiveState,
  MemoryStorage,
  obj,
  type SubmissionId,
  str,
  type TaskId,
  type Usage,
  type UsageState,
} from '../pi-boundary.js';
import {
  faultsOf,
  type KubicLaneEvent,
  laneEventsBetween,
  snapshotOf,
  subscribeLaneEvents,
  windowSkipped,
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

function assistantMessage(content: unknown[], usage: Usage = FULL_USAGE) {
  return {
    role: 'assistant',
    content,
    api: 'faux',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage,
    stopReason: 'stop',
    timestamp: 0,
  };
}

function assistantEntry(id: number, content: unknown[] = []): EntryRecord {
  return entry(id, 'pi.assistant', assistantMessage(content));
}

function toolResultEntry(id: number, callId = 'c-1', isError = false) {
  return entry(id, 'pi.tool-result', {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'echo',
    content: [{ type: 'text', text: 'echo: hi' }],
    isError,
    timestamp: 0,
  });
}

function userEntry(id: number): EntryRecord {
  return entry(id, 'pi.user', { role: 'user', content: 'hi', timestamp: 0 });
}

const RUN = {
  taskId: 7 as TaskId,
  inputs: [4 as SubmissionId],
  turns: 0,
};

// A synthetic conversation view: its window of entries and the documents
// the events read.
function view(
  entries: readonly EntryRecord[],
  docs: { live?: LiveState; inbox?: InboxState; usage?: UsageState } = {},
  before?: number,
): ConversationView {
  return {
    conversation: {} as ConversationView['conversation'],
    entries,
    ...(before === undefined ? {} : { before: before as EntryId }),
    docs: {
      ...(docs.live === undefined ? {} : { 'pi.live': docs.live }),
      ...(docs.inbox === undefined ? {} : { 'pi.inbox': docs.inbox }),
      ...(docs.usage === undefined ? {} : { 'pi.usage': docs.usage }),
    } as ConversationView['docs'],
  };
}

function draft(text: string, thinking = ''): LiveState {
  return {
    run: RUN,
    generation: {
      attempt: 1,
      message: assistantMessage([
        ...(thinking === '' ? [] : [{ type: 'thinking', thinking }]),
        { type: 'text', text },
      ]) as unknown as NonNullable<LiveState['generation']>['message'],
    },
  };
}

describe('laneEventsBetween', () => {
  it('maps run start and end from pi.live', () => {
    const idle = view([]);
    const running = view([], { live: { run: RUN } });
    expect(laneEventsBetween(idle, running)).toEqual([
      { type: 'run-start', inputs: [4] },
    ]);
    expect(laneEventsBetween(running, idle)).toEqual([
      { type: 'run-end', inputs: [4] },
    ]);
    // A run that ends without an answer keeps its failure in pi.live; the
    // run still ended.
    const failed = view([], {
      live: {
        runFailure: {
          taskId: RUN.taskId,
          inputs: RUN.inputs,
          reason: 'aborted',
        },
      },
    });
    expect(laneEventsBetween(running, failed)).toEqual([
      { type: 'run-end', inputs: [4] },
    ]);
  });

  it('starts a tool with the arguments its assistant entry gave the call', () => {
    const call = assistantEntry(2, [
      { type: 'toolCall', id: 'c-1', name: 'echo', arguments: { text: 'hi' } },
    ]);
    const pending = view([call], {
      live: {
        run: RUN,
        tools: [{ callId: 'c-1', name: 'echo', status: 'pending' }],
      },
    });
    const running = view([call], {
      live: {
        run: RUN,
        tools: [{ callId: 'c-1', name: 'echo', status: 'running' }],
      },
    });
    expect(laneEventsBetween(pending, running)).toEqual([
      {
        type: 'tool-start',
        toolCallId: 'c-1',
        toolName: 'echo',
        args: { text: 'hi' },
      },
    ]);
    // Still running: no second start.
    expect(laneEventsBetween(running, running)).toEqual([]);
  });

  it('ends a tool directly before its result entry', () => {
    const call = assistantEntry(2, [
      { type: 'toolCall', id: 'c-1', name: 'echo', arguments: {} },
    ]);
    const result = toolResultEntry(3);
    const running = view([call], {
      live: {
        run: RUN,
        tools: [{ callId: 'c-1', name: 'echo', status: 'running' }],
      },
    });
    const done = view([call, result], {
      live: {
        run: RUN,
        tools: [
          { callId: 'c-1', name: 'echo', status: 'done', entry: result.id },
        ],
      },
    });
    expect(laneEventsBetween(running, done)).toEqual([
      {
        type: 'tool-end',
        toolCallId: 'c-1',
        toolName: 'echo',
        isError: false,
        entry: result,
      },
      { type: 'entry', entry: result },
    ]);
  });

  it('marks a failed result, and a done slot without one, as errors', () => {
    const failed = toolResultEntry(3, 'c-1', true);
    const running = view([], {
      live: {
        run: RUN,
        tools: [
          { callId: 'c-1', name: 'echo', status: 'running' },
          { callId: 'c-2', name: 'echo', status: 'running' },
        ],
      },
    });
    const done = view([failed], {
      live: {
        run: RUN,
        tools: [
          { callId: 'c-1', name: 'echo', status: 'done', entry: failed.id },
          // Faulted or orphaned: done without a result entry.
          { callId: 'c-2', name: 'echo', status: 'done' },
        ],
      },
    });
    expect(laneEventsBetween(running, done)).toEqual([
      {
        type: 'tool-end',
        toolCallId: 'c-1',
        toolName: 'echo',
        isError: true,
        entry: failed,
      },
      { type: 'entry', entry: failed },
      { type: 'tool-end', toolCallId: 'c-2', toolName: 'echo', isError: true },
    ]);
  });

  it('ends an unfinished tool whose run ended, with the result it left', () => {
    const result = toolResultEntry(3);
    const running = view([], {
      live: {
        run: RUN,
        tools: [{ callId: 'c-1', name: 'echo', status: 'running' }],
      },
    });
    const ended = view([result]);
    expect(laneEventsBetween(running, ended)).toEqual([
      {
        type: 'tool-end',
        toolCallId: 'c-1',
        toolName: 'echo',
        isError: false,
        entry: result,
      },
      { type: 'entry', entry: result },
      { type: 'run-end', inputs: [4] },
    ]);
  });

  it('streams the draft text as deltas, thinking left out', () => {
    const none = view([], { live: { run: RUN } });
    const hel = view([], { live: draft('Hel', 'pondering') });
    const hello = view([], { live: draft('Hello', 'pondering more') });
    expect(laneEventsBetween(none, hel)).toEqual([
      { type: 'message-delta', text: 'Hel' },
    ]);
    expect(laneEventsBetween(hel, hello)).toEqual([
      { type: 'message-delta', text: 'lo' },
    ]);
    // A thinking-only change carries no text.
    expect(laneEventsBetween(hello, hello)).toEqual([]);
  });

  it('starts a new draft after the entry that ended the previous one', () => {
    const answer = assistantEntry(5, [{ type: 'text', text: 'first' }]);
    const first = view([], { live: draft('first') });
    const second = view([answer], { live: draft('next') });
    const events = laneEventsBetween(first, second);
    expect(events.map((event) => event.type)).toEqual([
      'usage',
      'message-delta',
    ]);
    expect(events[1]).toEqual({ type: 'message-delta', text: 'next' });
  });

  it('maps an assistant entry to a usage row with its real provider/model', () => {
    const answer = assistantEntry(2);
    const [event] = laneEventsBetween(view([]), view([answer]));
    expect(event).toMatchObject({
      type: 'usage',
      entry: answer,
      row: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: FULL_USAGE,
        entryId: '2',
      },
    });
  });

  it('carries other committed messages as entries, and skips markers', () => {
    const user = userEntry(2);
    const marker = entry(3, 'pi.reset');
    expect(laneEventsBetween(view([]), view([user, marker]))).toEqual([
      { type: 'entry', entry: user },
    ]);
    // Only entries past the newest one already seen are new.
    expect(laneEventsBetween(view([user]), view([user, marker]))).toEqual([]);
  });

  it('maps retries and compactions', () => {
    const idle = view([], { live: { run: RUN } });
    const retrying = view([], {
      live: {
        run: RUN,
        generation: {
          attempt: 2,
          retry: { at: 10, error: 'server overloaded' },
        },
      },
    });
    expect(laneEventsBetween(idle, retrying)).toEqual([
      { type: 'retry', phase: 'start', attempt: 2, error: 'server overloaded' },
    ]);
    expect(laneEventsBetween(retrying, idle)).toEqual([
      { type: 'retry', phase: 'end', attempt: 2 },
    ]);
    const compacting = view([], {
      live: {
        run: RUN,
        compactions: [
          {
            taskId: 9 as TaskId<never>,
            trigger: 'threshold',
            blocking: true,
            attempt: 1,
          },
        ],
      },
    });
    expect(laneEventsBetween(idle, compacting)).toEqual([
      { type: 'compaction', phase: 'start', reason: 'threshold' },
    ]);
    expect(laneEventsBetween(compacting, idle)).toEqual([
      { type: 'compaction', phase: 'end', reason: 'threshold' },
    ]);
  });

  it('maps an inbox change to the queued items, ids as strings', () => {
    const queued = view([], {
      inbox: {
        items: [
          { id: 3 as SubmissionId, mode: 'followUp', content: 'next' },
          { id: 4 as SubmissionId, mode: 'write', entry: {} },
        ],
      },
    });
    expect(laneEventsBetween(view([]), queued)).toEqual([
      {
        type: 'inbox',
        items: [
          { id: '3', mode: 'followUp' },
          { id: '4', mode: 'write' },
        ],
      },
    ]);
    // The same queue in a new view object is no change.
    expect(laneEventsBetween(queued, { ...queued })).toEqual([]);
    expect(laneEventsBetween(queued, view([]))).toEqual([
      { type: 'inbox', items: [] },
    ]);
  });
});

describe('snapshotOf', () => {
  it('maps the view with replace semantics', () => {
    const answer = assistantEntry(1);
    const result = toolResultEntry(2, 'c-2');
    const usage: UsageState = {
      models: { 'faux/faux-1': FULL_USAGE },
      tools: {},
    };
    const snapshot = snapshotOf(
      view([answer, result], {
        live: {
          run: RUN,
          generation: {
            attempt: 2,
            retry: { at: 10, error: 'server overloaded' },
          },
          tools: [
            { callId: 'c-1', name: 'echo', status: 'running' },
            { callId: 'c-2', name: 'echo', status: 'done', entry: result.id },
            { callId: 'c-3', name: 'echo', status: 'done' },
          ],
          compactions: [
            {
              taskId: 9 as TaskId<never>,
              trigger: 'threshold',
              blocking: true,
              attempt: 1,
            },
          ],
        },
        usage,
      }),
      [answer, result],
    );
    expect(snapshot).toEqual({
      type: 'snapshot',
      entries: [answer, result],
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
          entry: result,
        },
        // Done without a result entry: faulted or orphaned.
        { toolCallId: 'c-3', toolName: 'echo', status: 'done', isError: true },
      ],
      retry: { attempt: 2, error: 'server overloaded' },
      compactions: [
        { taskId: 9, reason: 'threshold', blocking: true, attempt: 1 },
      ],
      usage,
    });
  });

  it('reads an idle, empty conversation as no run and zero usage', () => {
    expect(snapshotOf(view([]), [])).toEqual({
      type: 'snapshot',
      entries: [],
      tools: [],
      compactions: [],
      usage: { models: {}, tools: {} },
    });
  });
});

describe('windowSkipped', () => {
  it('is true only when the window starts past the newest entry seen', () => {
    const seen = view([userEntry(10)]);
    expect(windowSkipped(seen, view([userEntry(10), userEntry(11)]))).toBe(
      false,
    );
    expect(windowSkipped(seen, view([userEntry(60)], {}, 10))).toBe(false);
    expect(windowSkipped(seen, view([userEntry(60)], {}, 59))).toBe(true);
    // An empty first view has seen nothing to skip past.
    expect(windowSkipped(view([]), view([userEntry(60)], {}, 59))).toBe(false);
  });
});

describe('faultsOf', () => {
  function taskChange(
    conversationId: number,
    kind: string,
    outcome: unknown,
  ): CommitPublication['changes'][number] {
    return {
      type: 'task',
      value: {
        id: 5,
        kind,
        conversationId,
        state: { status: 'terminal', outcome },
      },
    } as unknown as CommitPublication['changes'][number];
  }

  it('reports this conversation’s faulted and orphaned tasks only', () => {
    const publication = {
      seq: 1,
      changes: [
        taskChange(1, 'pi.generation', {
          status: 'faulted',
          error: { message: 'boom' },
        }),
        taskChange(1, 'pi.tool', { status: 'orphaned', reason: 'lost' }),
        taskChange(1, 'pi.tool', { status: 'completed', result: {} }),
        taskChange(2, 'pi.tool', {
          status: 'faulted',
          error: { message: 'elsewhere' },
        }),
      ],
    } as unknown as CommitPublication;
    expect(faultsOf(publication, CONVERSATION)).toEqual([
      { type: 'fault', code: 'pi.generation', message: 'boom' },
      { type: 'fault', code: 'pi.tool', message: 'lost' },
    ]);
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
  parameters: obj({ text: str() }),
  replay: 'safe',
  async execute(args) {
    return { output: [{ type: 'text', text: `echo: ${args.text}` }] };
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

describe('subscribeLaneEvents over the conversation view', () => {
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

  it('labels usage rows with the provider and model that answered', async () => {
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

  it('usage rows carry the committed entry usage verbatim, totals sum it', async () => {
    // The harness measures usage at commit (the provider hint is not
    // preserved verbatim), so the honest pin is pass-through fidelity:
    // every row deep-equals its own entry's message usage, and the totals
    // a cost rollup would read sum exactly those rows — the mapping and
    // the transport invent nothing.
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
      await runTurn(lane, 'say hi');
      await flush();
    } finally {
      await stop();
    }
    const usages = seen.filter((event) => event.type === 'usage');
    expect(usages.length).toBeGreaterThan(0);
    const totals = { prompt: 0, output: 0, totalTokens: 0 };
    for (const event of usages) {
      if (event.type !== 'usage') continue;
      expect(event.row.provider).toBe('faux');
      expect(event.row.model).toBe('faux-1');
      // Same role narrowing usageRowFromEntry uses: only assistant
      // messages carry usage.
      const message = event.entry.model?.[0];
      if (message?.role !== 'assistant') {
        throw new Error('expected an assistant message on the usage entry');
      }
      expect(event.row.usage).toEqual(message.usage);
      expect(event.row.entryId).toBe(String(event.entry.id));
      // The faux provider books the prompt as a cache write.
      totals.prompt +=
        event.row.usage.input +
        event.row.usage.cacheRead +
        event.row.usage.cacheWrite;
      totals.output += event.row.usage.output;
      totals.totalTokens += event.row.usage.totalTokens;
    }
    // Non-zero measured usage flowed end to end. No input+output
    // identity: the harness measures totalTokens on its own accounting.
    expect(totals.prompt).toBeGreaterThan(0);
    expect(totals.output).toBeGreaterThan(0);
    expect(totals.totalTokens).toBeGreaterThan(0);
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

  it('folds a burst of commits into cells without duplicating any', async () => {
    const lane = await boot({
      responses: [
        fauxAssistantMessage(fauxToolCall('echo', { text: 'one' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(fauxText('first')),
        fauxAssistantMessage(fauxText('second')),
      ],
    });
    await runTurn(lane, 'first');
    const seen: KubicLaneEvent[] = [];
    const stop = await subscribeLaneEvents(
      lane.harness,
      lane.conversation.id,
      (event) => seen.push(event),
      BACKGROUND_CONTEXT,
    );
    try {
      // More commits than the view's window holds, admitted together: the
      // watch folds them, and a window that moved past unseen entries
      // rebases on a fresh snapshot.
      await Promise.all(
        Array.from({ length: 120 }, (_, i) =>
          lane.conversation.submit(
            { type: 'write', entry: { kind: 'test.note', data: i } },
            BACKGROUND_CONTEXT,
          ),
        ),
      );
      await runTurn(lane, 'second');
      await flush();
    } finally {
      await stop();
    }

    // Fold like the TUI feed does: a snapshot REPLACES the transcript
    // cells, an entry-bearing event UPSERTS exactly that entry.
    const cells: number[] = [];
    const index = new Map<number, number>();
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
    for (const event of seen) {
      if (event.type === 'snapshot') {
        cells.length = 0;
        index.clear();
        for (const committed of event.entries) push(committed);
      } else if ('entry' in event && event.entry !== undefined) {
        push(event.entry);
      }
    }
    expect(seen[0]?.type).toBe('snapshot');
    // The second turn's answer is the last cell, and no cell appears twice.
    const answers = seen.filter((event) => event.type === 'usage');
    const last = answers.at(-1);
    expect(last?.type === 'usage' ? (last.entry.id as number) : -1).toBe(
      cells.at(-1),
    );
    expect(cells.length).toBe(index.size);
  });
});
