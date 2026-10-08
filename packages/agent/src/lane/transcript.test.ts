// The shared pi-durable → Kubic transcript adapter. Entries are pi-durable
// `EntryRecord`s (typed records: pi.user, pi.assistant, pi.tool-result,
// pi.system, pi.compaction, pi.reset), read through `Conversation.context()` or
// the session storage. The adapter is the ONE reader every Kubic surface shares
// (sessions attach, cost, trajectory), so its mapping is pinned here: per-kind
// extraction, entry order, and the kinds it ignores.
//
// The live half of this file drives a REAL pi-durable Harness over
// MemoryStorage with the faux provider (zero network, zero paid tokens), so
// the stored shapes the adapter must read are the ones the harness writes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssistantEntry,
  BACKGROUND_CONTEXT,
  CompactionEntry,
  createModels,
  createRegistry,
  type EntryRecord,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
  ResetEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
} from '../pi-boundary.js';
import {
  entriesToTranscript,
  readConversationEntries,
  readSessionEntries,
} from './transcript.js';

// A fixed harness clock: entry ids and message timestamps are deterministic.
const NOW = Date.parse('2026-10-01T09:00:00.000Z');

const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
});

// A real harness over MemoryStorage with one faux provider model.
async function fauxHarness(
  settings: Parameters<typeof Harness.open>[1]['settings'] = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry(), now: () => NOW, settings },
    BACKGROUND_CONTEXT,
  );
  open.push(harness);
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });
  return { faux, harness, root };
}

// Hand-built durable entries for the focused per-kind table: the same
// record shape `Storage.scanEntries` returns (id, conversationId, kind,
// model/data).
let nextId = 100;
beforeEach(() => {
  nextId = 100;
});
function entry(kind: string, fields: Partial<EntryRecord> = {}): EntryRecord {
  nextId += 1;
  return {
    id: nextId as EntryRecord['id'],
    conversationId: 1 as EntryRecord['conversationId'],
    kind,
    ...fields,
  };
}

describe('entriesToTranscript kinds', () => {
  it('maps a user entry to its text', () => {
    const items = entriesToTranscript([
      entry(UserEntry.kind, {
        model: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'read a.txt' }],
            timestamp: NOW,
          },
        ],
      }),
    ]);
    expect(items).toEqual([
      { kind: 'user', text: 'read a.txt', entryId: '101' },
    ]);
  });

  it('maps a user entry whose content is a plain string', () => {
    const items = entriesToTranscript([
      entry(UserEntry.kind, {
        model: [{ role: 'user', content: 'hello', timestamp: NOW }],
      }),
    ]);
    expect(items).toEqual([{ kind: 'user', text: 'hello', entryId: '101' }]);
  });

  it('maps an assistant entry with text, tool calls, usage and model identity', () => {
    const items = entriesToTranscript([
      entry(AssistantEntry.kind, {
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              {
                type: 'toolCall',
                id: 'call-1',
                name: 'read',
                arguments: { path: 'a.txt' },
              },
            ],
            api: 'faux',
            provider: 'faux',
            model: 'faux-1',
            thinkingLevel: 'high',
            usage: {
              input: 10,
              output: 4,
              cacheRead: 2,
              cacheWrite: 0,
              totalTokens: 14,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.001,
              },
            },
            stopReason: 'toolUse',
            timestamp: NOW,
          },
        ],
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'assistant',
      text: 'checking',
      toolCalls: [{ id: 'call-1', name: 'read', args: { path: 'a.txt' } }],
      provider: 'faux',
      model: 'faux-1',
      thinkingLevel: 'high',
      entryId: '101',
    });
    expect((items[0] as { usage?: { input?: number } }).usage?.input).toBe(10);
  });

  it('maps an assistant entry without usage or model identity', () => {
    const items = entriesToTranscript([
      entry(AssistantEntry.kind, {
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            api: 'faux',
            provider: 'faux',
            model: 'faux-1',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            timestamp: NOW,
          },
        ],
      }),
    ]);
    expect(items[0]).toMatchObject({
      kind: 'assistant',
      text: 'hi',
      toolCalls: [],
    });
    expect(
      (items[0] as { thinkingLevel?: string }).thinkingLevel,
    ).toBeUndefined();
  });

  it('maps a tool-result entry, carrying the error flag', () => {
    const items = entriesToTranscript([
      entry(ToolResultEntry.kind, {
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', data: 'x', mimeType: 'image/png' },
              { type: 'text', text: 'line two' },
            ],
            isError: true,
            timestamp: NOW,
          },
        ],
      }),
    ]);
    expect(items).toEqual([
      {
        kind: 'tool-result',
        callId: 'call-1',
        name: 'read',
        text: 'line one\nline two',
        isError: true,
        entryId: '101',
      },
    ]);
  });

  it('maps a system entry to its instruction text', () => {
    const items = entriesToTranscript([
      entry(SystemEntry.kind, {
        model: [{ role: 'system', content: 'You are Kubic.', timestamp: NOW }],
      }),
    ]);
    expect(items).toEqual([
      { kind: 'system', text: 'You are Kubic.', entryId: '101' },
    ]);
  });

  it('maps a compaction entry to its summary text', () => {
    const items = entriesToTranscript([
      entry(CompactionEntry.kind, {
        data: { reason: 'manual' },
        model: [
          {
            role: 'user',
            content: [{ type: 'text', text: '## Goal\nDo the thing.' }],
            timestamp: NOW,
          },
        ],
      }),
    ]);
    expect(items).toEqual([
      { kind: 'compaction', text: '## Goal\nDo the thing.', entryId: '101' },
    ]);
  });

  it('maps a reset entry with and without a handoff message', () => {
    const items = entriesToTranscript([
      entry(ResetEntry.kind, {
        model: [{ role: 'user', content: 'take over here', timestamp: NOW }],
      }),
      entry(ResetEntry.kind),
    ]);
    expect(items).toEqual([
      { kind: 'reset', text: 'take over here', entryId: '101' },
      { kind: 'reset', entryId: '102' },
    ]);
  });

  it('skips unknown kinds and entries with no model payload', () => {
    const items = entriesToTranscript([
      entry('app.note', { data: 'not a transcript item' }),
      entry(UserEntry.kind),
      entry(AssistantEntry.kind, { model: [] }),
      entry(UserEntry.kind, {
        model: [{ role: 'user', content: 'kept', timestamp: NOW }],
      }),
    ]);
    expect(items).toEqual([{ kind: 'user', text: 'kept', entryId: '104' }]);
  });

  it('returns the transcript in entry-id order whatever order it is given', () => {
    const first = entry(UserEntry.kind, {
      model: [{ role: 'user', content: 'first', timestamp: NOW }],
    });
    const second = entry(UserEntry.kind, {
      model: [{ role: 'user', content: 'second', timestamp: NOW }],
    });
    const items = entriesToTranscript([second, first]);
    expect(items.map((item) => item.text)).toEqual(['first', 'second']);
  });
});

describe('entriesToTranscript over a real harness', () => {
  it('reads the user turn, the tool call, its result and the answer the harness stored', async () => {
    const { faux, root } = await fauxHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('read returned 6 chars'),
    ]);
    await (
      await root.submit(
        { type: 'input', content: 'read a.txt' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    const { entries } = await root.context(BACKGROUND_CONTEXT);
    const items = entriesToTranscript(entries);

    // Every stored entry maps to exactly one item, in transcript order.
    expect(items).toHaveLength(entries.length);
    expect(items.map((item) => item.entryId)).toEqual(
      entries.map((entry) => String(entry.id)),
    );
    const user = items.find((item) => item.kind === 'user');
    expect(user?.text).toBe('read a.txt');
    const assistant = items.find((item) => item.kind === 'assistant');
    expect(assistant?.toolCalls).toEqual([
      { id: expect.any(String), name: 'read', args: { path: 'a.txt' } },
    ]);
    expect(assistant?.provider).toBe('faux');
    expect(assistant?.model).toBe('faux-1');
    const result = items.find((item) => item.kind === 'tool-result');
    expect(result?.name).toBe('read');
    expect(result?.callId).toBe(assistant?.toolCalls[0]?.id);
    expect(items.at(-1)?.text).toBe('read returned 6 chars');
  });

  it('reads the compaction summary the harness stored', async () => {
    const { faux, harness, root } = await fauxHarness({
      compaction: { keepRecentTokens: 0 },
    });
    faux.setResponses([
      fauxAssistantMessage('a long answer'),
      fauxAssistantMessage('## Goal\nSummarized.'),
    ]);
    await (
      await root.submit({ type: 'input', content: 'work' }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    const task = await root.compact(undefined, BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(task, BACKGROUND_CONTEXT);
    // The summary is placed through a write submission: wait for that write
    // so the entry is committed when the transcript is read.
    const submissionId =
      settled.state.outcome.status === 'completed'
        ? settled.state.outcome.result.submissionId
        : undefined;
    if (submissionId !== undefined) {
      await (await harness.submission(submissionId, BACKGROUND_CONTEXT))?.wait(
        BACKGROUND_CONTEXT,
      );
    }
    const { entries } = await root.context(BACKGROUND_CONTEXT);
    const items = entriesToTranscript(entries);
    const compaction = items.find((item) => item.kind === 'compaction');
    expect(compaction?.text).toContain('Summarized.');
  });

  it('reads a reset handoff and starts the transcript at the new context', async () => {
    const { faux, root } = await fauxHarness();
    faux.setResponses([fauxAssistantMessage('before the reset')]);
    await (
      await root.submit(
        { type: 'input', content: 'first turn' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    await root.commit(
      (tx) =>
        tx.appendEntry(ResetEntry, root.id, {
          head: 'self',
          model: [{ role: 'user', content: 'handoff text', timestamp: NOW }],
        }),
      BACKGROUND_CONTEXT,
    );
    const { entries } = await root.context(BACKGROUND_CONTEXT);
    const items = entriesToTranscript(entries);
    // A reset starts a new context: the transcript begins at the reset
    // entry and the turn before it is inactive.
    expect(items[0]).toMatchObject({ kind: 'reset', text: 'handoff text' });
    expect(items.some((item) => item.text === 'first turn')).toBe(false);
  });

  it('reads the same active transcript straight from the session storage', async () => {
    // The CLI readers attach to a session and read its Storage without
    // booting a harness (no model layer, no writes): the storage-direct
    // reader must see the same active context the conversation reports.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = new MemoryStorage();
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry(), now: () => NOW },
      BACKGROUND_CONTEXT,
    );
    open.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    });
    faux.setResponses([fauxAssistantMessage('stored answer')]);
    await (
      await root.submit(
        { type: 'input', content: 'stored prompt' },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);

    const fromStorage = await readSessionEntries(storage, BACKGROUND_CONTEXT);
    const fromConversation = await readConversationEntries(
      root,
      BACKGROUND_CONTEXT,
    );
    expect(fromStorage.map((entry) => entry.id)).toEqual(
      fromConversation.map((entry) => entry.id),
    );
    expect(entriesToTranscript(fromStorage).map((item) => item.text)).toEqual([
      'stored prompt',
      'stored answer',
    ]);
  });

  it('reads no transcript from a storage whose conversation never existed', async () => {
    // A freshly created session has metadata but no root conversation yet:
    // the reader must answer with nothing instead of failing.
    expect(
      await readSessionEntries(new MemoryStorage(), BACKGROUND_CONTEXT),
    ).toEqual([]);
  });
});
