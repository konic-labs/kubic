// Slice C: usage rows + kubic models CLI (issue #20; §39, §17/§18).
// Issue #433 deleted summarizeUsage (no supplier, no caller — `kubic cost
// --session <run>` is the roll-up surface); usageRowFromEntry stays.
import { describe, expect, it } from 'vitest';
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  Usage,
} from './pi-boundary.js';
import { usageRowFromEntry } from './usage.js';

function usage(over: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  };
}

describe('usage rows (issue #20, slice C)', () => {
  it('builds a per-response row from the assistant entry that answered (#287, #398)', () => {
    const committed = entry(7, 'pi.assistant', {
      role: 'assistant',
      content: [],
      api: 'faux',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: usage({ input: 3, output: 1, totalTokens: 4 }),
      stopReason: 'stop',
      timestamp: 0,
    });
    expect(usageRowFromEntry(committed)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: usage({ input: 3, output: 1, totalTokens: 4 }),
      entryId: '7',
    });
  });

  it('yields no row for entries that are not model responses', () => {
    expect(
      usageRowFromEntry(
        entry(8, 'pi.user', { role: 'user', content: 'hi', timestamp: 0 }),
      ),
    ).toBeUndefined();
    expect(
      usageRowFromEntry(
        entry(9, 'pi.tool-result', {
          role: 'toolResult',
          toolCallId: 'c-1',
          toolName: 'echo',
          content: [],
          isError: false,
          timestamp: 0,
        }),
      ),
    ).toBeUndefined();
    expect(usageRowFromEntry(entry(10, 'test.note'))).toBeUndefined();
  });
});

function entry(id: number, kind: string, message?: unknown): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind,
    ...(message === undefined
      ? {}
      : { model: [message] as unknown as EntryRecord['model'] }),
  };
}
