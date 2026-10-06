// Coarse lane-entry cells for the transcript (issue #88).
// RED: packages/tui/src/lane-cells.ts does not exist yet.
//
// §15.2 replicated lane snapshots: the TUI renders committed entries as
// coarse cells — no token deltas (Pi keeps those; §15 routes no message
// events). Pure: entries in, cells out, no I/O.
import { describe, expect, it } from 'vitest';
import {
  entriesToCells,
  forkPickerRows,
  type LaneEntryLike,
  sanitizeLaneText,
  summarizeToolArguments,
  summarizeToolOutcome,
  TAB_STOP,
  TOOL_DETAIL_MAX_CHARS,
  TOOL_OUTCOME_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  userPromptsOf,
} from './lane-cells.js';
import { visibleWidth } from './tui-boundary.js';

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
      summarizeToolOutcome(resultEntry('[bash exit 1 (bash)]\nboom'), 'bash'),
    ).toBe('exit 1');
    expect(
      summarizeToolOutcome(
        resultEntry(JSON.stringify({ stdout: 'x', exitCode: 3 })),
        'bash',
      ),
    ).toBe('exit 3');
    expect(
      summarizeToolOutcome(
        {
          message: {
            role: 'toolResult',
            content: [{ type: 'text', text: 'Tests: 3 passed, 1 failed' }],
          },
        },
        'bash',
      ),
    ).toBe('3 passed, 1 failed');
  });

  it('only summarises the shell tool, never a read of shell-shaped text', () => {
    const text = '[bash exit 1 (bash)]\n17 passed';
    // The shell tool gets the summary (it wins over the exit code) …
    expect(summarizeToolOutcome(resultEntry(text), 'bash')).toBe('17 passed');
    // … while a file's shell-shaped text is not the file tool's outcome.
    expect(summarizeToolOutcome(resultEntry(text))).toBeUndefined();
    expect(summarizeToolOutcome(resultEntry(text), 'read')).toBeUndefined();
    expect(
      summarizeToolOutcome(resultEntry('17 passed'), 'grep'),
    ).toBeUndefined();
  });

  it('prefers a test summary over a zero exit and hides a clean exit', () => {
    expect(
      summarizeToolOutcome(
        resultEntry('[bash exit 0 (bash)]\n--- stdout ---\n17 passed'),
        'bash',
      ),
    ).toBe('17 passed');
    expect(
      summarizeToolOutcome(
        resultEntry('[bash exit 0 (bash)]\nnothing'),
        'bash',
      ),
    ).toBeUndefined();
  });

  it('sanitizes, collapses and bounds what it returns', () => {
    const ESC = String.fromCharCode(27);
    const summary = summarizeToolOutcome(
      resultEntry(`\n\nTests ${'9'.repeat(80)} passed${ESC}[2J`),
      'bash',
    );
    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThanOrEqual(TOOL_OUTCOME_MAX_CHARS);
    expect(summary).not.toContain(ESC);
  });

  it('ignores anything that is not a tool result', () => {
    expect(summarizeToolOutcome(undefined, 'bash')).toBeUndefined();
    expect(summarizeToolOutcome('nope', 'bash')).toBeUndefined();
    expect(
      summarizeToolOutcome(resultEntry('text', 'assistant'), 'bash'),
    ).toBeUndefined();
    expect(summarizeToolOutcome({ model: [] }, 'bash')).toBeUndefined();
    expect(
      summarizeToolOutcome(
        { model: [{ role: 'toolResult', content: [] }] },
        'bash',
      ),
    ).toBeUndefined();
  });
});

describe('lane text sanitisation (issue #299)', () => {
  it('strips a complete SGR sequence, not just the ESC byte', () => {
    expect(sanitizeLaneText('\u001b[31mred\u001b[0m')).toBe('red');
    expect(sanitizeLaneText('plain \u001b[1;32mok\u001b[m done')).toBe(
      'plain ok done',
    );
  });

  it('strips OSC hyperlinks and titles whole', () => {
    expect(
      sanitizeLaneText(
        '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
      ),
    ).toBe('link');
    expect(sanitizeLaneText('\u001b]0;my title\u0007body')).toBe('body');
    // The ST-terminated form (`ESC \`) too.
    expect(sanitizeLaneText('\u001b]0;title\u001b\\body')).toBe('body');
  });

  it('strips the 8-bit C1 CSI form and 2-byte ESC forms', () => {
    expect(sanitizeLaneText('\u009b31mred')).toBe('red');
    expect(sanitizeLaneText('\u001b(Bascii')).toBe('ascii');
    expect(sanitizeLaneText('\u001b=keypad')).toBe('keypad');
  });

  it('collapses carriage-return overwrites to the final text', () => {
    expect(sanitizeLaneText('a 10%\ra 100%')).toBe('a 100%');
    // A progress line that ends in CR loses the dangling return.
    expect(sanitizeLaneText('progress\r')).toBe('progress');
    // Only the LAST overwrite survives, per line.
    expect(sanitizeLaneText('one\rtwo\rthree\nkeep')).toBe('three\nkeep');
  });

  it('expands tabs by visible column width, not UTF-16 length', () => {
    const expanded = sanitizeLaneText('日本\tc');
    expect(expanded).toBe('日本    c');
    // 'c' really sits at column 8: the two wide glyphs count as 4 columns,
    // so the tab pads 4, not 6 (which UTF-16 length would have done).
    expect(visibleWidth(expanded.slice(0, expanded.indexOf('c')))).toBe(8);
  });

  it('expands a long tab run in one pass, not per tab (review #299)', () => {
    // 20 000 tabs: the quadratic version rescanned the whole prefix per tab
    // (~3e9 code units) and blew the test timeout; the running-column pass
    // is linear and every tab still lands on an 8-column stop.
    const expanded = sanitizeLaneText('\t'.repeat(20_000));
    expect(expanded.length).toBe(20_000 * TAB_STOP);
    expect(visibleWidth(expanded) % TAB_STOP).toBe(0);
    // A tab run after wide glyphs stays column-correct.
    const mixed = sanitizeLaneText(`日本${'\t'.repeat(1000)}`);
    expect(mixed.startsWith('日本    ')).toBe(true);
    expect(visibleWidth(mixed) % TAB_STOP).toBe(0);
  });

  it('still drops C0 controls and keeps tab/newline', () => {
    expect(sanitizeLaneText('a\u0007b')).toBe('ab');
    expect(sanitizeLaneText('a\tb\nc')).toBe('a       b\nc');
  });
});

describe('compaction cells (issue #317)', () => {
  const SUMMARY = `The conversation history before this point was compacted into the following summary:\n\n<summary>\nOlder turns were summarized here.\n</summary>`;

  function compactionEntry(text: string): LaneEntryLike {
    return {
      id: 'c9',
      seq: 9,
      type: 'compaction',
      reason: 'auto',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }

  it('renders a compaction summary as its own cell, wrapper stripped', () => {
    const cells = entriesToCells([compactionEntry(SUMMARY)]);
    expect(cells).toEqual([
      {
        id: 'c9:compaction',
        kind: 'compaction',
        markdown: 'Older turns were summarized here.',
        detail: 'auto',
      },
    ]);
  });

  it('sanitizes the summary like any other lane text', () => {
    const ESC = String.fromCharCode(27);
    const cells = entriesToCells([
      compactionEntry(`${SUMMARY.replace('here.', `here${ESC}[31m.`)}`),
    ]);
    expect(cells[0]?.markdown).toBe('Older turns were summarized here.');
    expect(cells[0]?.markdown).not.toContain('[31m');
    expect(cells[0]?.markdown).not.toContain(ESC);
  });

  it('renders a reset handoff as text and drops an empty entry', () => {
    const cells = entriesToCells([
      {
        id: 'r1',
        seq: 1,
        type: 'reset',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'handoff text' }],
        },
      },
      {
        id: 'r2',
        seq: 2,
        type: 'compaction',
        message: { role: 'user', content: [] },
      },
    ]);
    expect(cells.map((cell) => cell.markdown)).toEqual(['handoff text']);
    expect(cells[0]?.kind).toBe('text');
  });
});

// Issue #340: the committed user prompts of a lane, newest last, for seeding
// the editor history on resume. Compaction summaries (role user inside a
// `compaction` entry) and image-only prompts are not prompts to recall.
describe('userPromptsOf (issue #340)', () => {
  it('returns the user messages text in order and skips everything else', () => {
    const user = (id: string, text: string) => ({
      id,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    expect(
      userPromptsOf([
        user('1', 'first'),
        {
          id: '2',
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
        { id: '3', type: 'compaction', message: { role: 'user', content: [] } },
        {
          id: '4',
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          },
        },
        user('5', 'second\nline two'),
      ]),
    ).toEqual(['first', 'second\nline two']);
  });
});

// Issue #332: the `/tree` picker — one row per earlier prompt, newest first,
// each forking just BEFORE that prompt (so the operator retries from there).
describe('forkPickerRows (issue #332)', () => {
  it('lists prompts newest first with their entry and the fork point (headless snapshot)', () => {
    const rows = forkPickerRows([
      { entryId: 8, at: 7, text: 'fix the failing test' },
      {
        entryId: 14,
        at: 13,
        text: 'now refactor the parser into two modules and keep the public API exactly as it is',
      },
    ]);
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "description": "fork before this prompt (at #13)",
          "label": "#14  now refactor the parser into two modules and keep the publi…",
          "value": "13:14",
        },
        {
          "description": "fork before this prompt (at #7)",
          "label": "#8  fix the failing test",
          "value": "7:8",
        },
      ]
    `);
  });

  it('keeps a multi-line prompt on one label line', () => {
    const [row] = forkPickerRows([{ entryId: 3, at: 2, text: 'one\ntwo' }]);
    expect(row?.label).toBe('#3  one two');
  });
});

describe('prompt timestamps (issue #455)', () => {
  it('carries the message time onto the prompt cell, and only a real number', () => {
    const at = Date.UTC(2026, 9, 6, 12, 1, 52);
    const cells = entriesToCells([
      {
        id: 'u1',
        seq: 1,
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'fix the cart' }],
          timestamp: at,
        },
      },
      {
        id: 'u2',
        seq: 2,
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'again' }],
          timestamp: 'yesterday',
        },
      },
    ]);
    expect(cells[0]).toMatchObject({ kind: 'prompt', timestamp: at });
    expect(cells[1]?.timestamp).toBeUndefined();
  });
});
