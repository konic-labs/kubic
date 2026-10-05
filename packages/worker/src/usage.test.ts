// Slice C: usage rollups + kubic models CLI (issue #20; §39, §17/§18).
// RED: summarizeUsage did not exist yet (formatUsageLine was deleted by
// issue #216 — cost readers format their own rows).
import { describe, expect, it } from 'vitest';
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  Usage,
} from './pi-boundary.js';
import {
  type KubicUsageRow,
  summarizeUsage,
  usageRowFromEntry,
} from './usage.js';

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

function row(over: Partial<KubicUsageRow>): KubicUsageRow {
  return {
    model: 'local/llama3',
    provider: 'local',
    usage: usage({}),
    ...over,
  };
}

describe('usage rollups (issue #20, slice C)', () => {
  it('sums requests, tokens, cache split, and priced cost', () => {
    const summary = summarizeUsage([
      row({
        usage: usage({
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          totalTokens: 180,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.001,
            cacheWrite: 0.002,
            total: 0.033,
          },
        }),
      }),
      row({
        model: 'faux/big',
        provider: 'faux',
        usage: usage({ input: 10, output: 5, totalTokens: 15 }),
      }),
    ]);
    expect(summary.requests).toBe(2);
    expect(summary.input).toBe(110);
    expect(summary.output).toBe(55);
    expect(summary.cacheRead).toBe(20);
    expect(summary.cacheWrite).toBe(10);
    expect(summary.costTotal).toBeCloseTo(0.033);
    expect(summary.byModel['local/llama3']?.requests).toBe(1);
    expect(summary.byModel['faux/big']?.input).toBe(10);
  });

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
