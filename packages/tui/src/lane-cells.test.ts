// Coarse lane-entry cells for the transcript (issue #88).
// RED: packages/tui/src/lane-cells.ts does not exist yet.
//
// §15.2 replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; §15 routes no message
// events). Pure: entries in, cells out, no I/O.
import { describe, expect, it } from 'vitest';
import { entriesToCells, TOOL_RESULT_MAX_CHARS } from './lane-cells.js';

function userEntry(id: string, seq: number, text: string) {
  return {
    id,
    seq,
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantEntry(
  id: string,
  seq: number,
  parts: Array<Record<string, unknown>>,
) {
  return {
    id,
    seq,
    type: 'message',
    message: { role: 'assistant', content: parts },
  };
}

describe('lane entries to transcript cells (issue #88)', () => {
  it('orders cells chronologically even when entries arrive newest-first', () => {
    const cells = entriesToCells([
      assistantEntry('a2', 40, [{ type: 'text', text: 'all done' }]),
      userEntry('u1', 10, 'read foo'),
    ]);
    expect(cells.map((cell) => cell.markdown)).toEqual([
      '› read foo',
      'all done',
    ]);
  });

  it('renders assistant text and tool calls as separate cells', () => {
    const cells = entriesToCells([
      assistantEntry('a1', 20, [
        { type: 'text', text: 'reading foo' },
        { type: 'toolCall', id: 'tool:1', name: 'read', arguments: {} },
      ]),
    ]);
    expect(cells).toEqual([
      { id: 'a1:text', kind: 'text', markdown: 'reading foo' },
      { id: 'a1:tool:1', kind: 'tool', markdown: 'tool read' },
    ]);
  });

  it('renders tool results as truncated output cells', () => {
    const long = `line one\n${'x'.repeat(500)}`;
    const cells = entriesToCells([
      {
        id: 'r1',
        seq: 30,
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: long }],
        },
      },
    ]);
    // Collapsed to one line, cut at the bound, and marked with an ellipsis.
    const oneLine = `line one ${'x'.repeat(500)}`;
    expect(cells).toEqual([
      {
        id: 'r1:result',
        kind: 'output',
        markdown: `${oneLine.slice(0, TOOL_RESULT_MAX_CHARS - 1)}…`,
      },
    ]);
  });

  it('skips entries it cannot render and keeps ids unique', () => {
    const cells = entriesToCells([
      { id: 'c1', seq: 5, type: 'compaction' },
      assistantEntry('a1', 6, [{ type: 'thinking', text: 'hmm' }]),
      // No id: a cell id could not be derived, so it is dropped.
      {
        seq: 7,
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'orphan' }] },
      },
      // Several parts of one entry: each cell id carries its part index.
      assistantEntry('a2', 8, [
        { type: 'text', text: 'first' },
        { type: 'toolCall', name: 'read', arguments: {} },
        { type: 'text', text: 'second' },
      ]),
    ]);
    expect(cells.map((cell) => cell.id)).toEqual([
      'a2:text',
      'a2:1',
      'a2:text:2',
    ]);
  });
});
