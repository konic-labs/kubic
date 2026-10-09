// The durable entry chain of one faux run with a single read call, plus one
// entry from an earlier run, for the run trajectory tests.

export const STARTED = Date.parse('2026-09-28T10:00:00.000Z');

function usage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

// The durable entry chain of one faux run with a single `read` call
// (pi-durable `EntryRecord`s: typed kinds, `model` payloads), plus one entry
// from an earlier run. Entries carry no timestamp of their own — the
// messages do — and the array is deliberately out of id order: entry ids are
// assigned in commit order, so the adapter restores transcript order.
export function assistantEntry(
  id: number,
  timestamp: number,
  content: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    conversationId: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content,
        api: 'faux',
        provider: 'faux',
        model: 'echo',
        usage: usage(20, 7, 0.001),
        stopReason: 'stop',
        timestamp,
        ...overrides,
      },
    ],
  };
}

export const ENTRIES: unknown[] = [
  assistantEntry(40, STARTED + 30, [
    { type: 'text', text: 'faux: read returned 6 chars' },
  ]),
  {
    id: 29,
    conversationId: 1,
    kind: 'pi.tool-result',
    data: { diagnostics: [] },
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'hello\n' }],
        isError: false,
        timestamp: STARTED + 20,
      },
    ],
  },
  assistantEntry(
    19,
    STARTED + 10,
    [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: { path: 'a.txt' },
      },
    ],
    { usage: usage(100, 6, 0.002) },
  ),
  {
    id: 6,
    conversationId: 1,
    kind: 'pi.user',
    model: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'read a.txt' }],
        timestamp: STARTED + 1,
      },
    ],
  },
  // An earlier run of a resumed session: never part of this trajectory.
  assistantEntry(
    2,
    STARTED - 60_000,
    [{ type: 'toolCall', id: 'old', name: 'bash', arguments: { cmd: 'x' } }],
    { usage: usage(999, 999, 9) },
  ),
];
