// Coarse lane-entry cells for the transcript (issue #88).
// RED: packages/tui/src/lane-cells.ts does not exist yet.
//
// §15.2 replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; §15 routes no message
// events). Pure: entries in, cells out, no I/O.
import { describe, expect, it } from 'vitest';
import {
  entriesToCells,
  summarizeToolArguments,
  summarizeToolOutcome,
  TOOL_DETAIL_MAX_CHARS,
  TOOL_OUTCOME_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
} from './lane-cells.js';

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
      {
        id: 'a1:tool:1',
        kind: 'tool',
        markdown: 'tool read',
        toolCallId: 'tool:1',
      },
    ]);
  });

  it('keeps tool results multi-line, bounded, and paired to their call', () => {
    const long = `line one\n${'x'.repeat(TOOL_RESULT_MAX_CHARS + 50)}`;
    const cells = entriesToCells([
      {
        id: 'r1',
        seq: 30,
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          isError: true,
          content: [{ type: 'text', text: long }],
        },
      },
    ]);
    // Lines survive (the view collapses them); the char bound still holds.
    expect(cells).toEqual([
      {
        id: 'r1:result',
        kind: 'output',
        markdown: `${long.slice(0, TOOL_RESULT_MAX_CHARS - 1)}…`,
        isError: true,
        toolCallId: 'call-1',
      },
    ]);
  });

  it('unpacks a shell JSON record into its stdout and exit code', () => {
    const record = JSON.stringify({
      command: 'false',
      exitCode: 2,
      stdout: 'a\nb\n',
      stderr: 'boom\n',
    });
    const cells = entriesToCells([
      {
        id: 'r2',
        seq: 1,
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: record }],
        },
      },
    ]);
    expect(cells[0]?.markdown).toBe('a\nb\nboom\nexit 2');
  });

  it('summarizes tool call arguments by their primary field', () => {
    const cells = entriesToCells([
      assistantEntry('a3', 1, [
        {
          type: 'toolCall',
          id: 'c1',
          name: 'bash',
          arguments: { command: 'ls\n-la' },
        },
        { type: 'toolCall', id: 'c2', name: 'x', arguments: { n: 1 } },
      ]),
    ]);
    expect(cells.map((cell) => cell.detail)).toEqual(['ls -la', '{"n":1}']);
    expect(summarizeToolArguments({ path: 'a'.repeat(200) }).length).toBe(
      TOOL_DETAIL_MAX_CHARS,
    );
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

describe('tool outcome summary (issue #345)', () => {
  function resultEntry(text: string, role = 'toolResult'): unknown {
    return {
      id: 1,
      kind: 'pi.tool-result',
      model: [{ role, content: [{ type: 'text', text }] }],
    };
  }

  it('reads the pi-durable bash header, the JSON record and the lane shape', () => {
    expect(
      summarizeToolOutcome(resultEntry('[bash exit 1 (bash)]\nboom')),
    ).toBe('exit 1');
    expect(
      summarizeToolOutcome(
        resultEntry(JSON.stringify({ stdout: 'x', exitCode: 3 })),
      ),
    ).toBe('exit 3');
    expect(
      summarizeToolOutcome({
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: 'Tests: 3 passed, 1 failed' }],
        },
      }),
    ).toBe('3 passed, 1 failed');
  });

  it('prefers a test summary over a zero exit and hides a clean exit', () => {
    expect(
      summarizeToolOutcome(
        resultEntry('[bash exit 0 (bash)]\n--- stdout ---\n17 passed'),
      ),
    ).toBe('17 passed');
    expect(
      summarizeToolOutcome(resultEntry('[bash exit 0 (bash)]\nnothing')),
    ).toBeUndefined();
  });

  it('sanitizes, collapses and bounds what it returns', () => {
    const ESC = String.fromCharCode(27);
    const summary = summarizeToolOutcome(
      resultEntry(`\n\nTests ${'9'.repeat(80)} passed${ESC}[2J`),
    );
    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThanOrEqual(TOOL_OUTCOME_MAX_CHARS);
    expect(summary).not.toContain(ESC);
  });

  it('ignores anything that is not a tool result', () => {
    expect(summarizeToolOutcome(undefined)).toBeUndefined();
    expect(summarizeToolOutcome('nope')).toBeUndefined();
    expect(
      summarizeToolOutcome(resultEntry('text', 'assistant')),
    ).toBeUndefined();
    expect(summarizeToolOutcome({ model: [] })).toBeUndefined();
    expect(
      summarizeToolOutcome({ model: [{ role: 'toolResult', content: [] }] }),
    ).toBeUndefined();
  });
});
