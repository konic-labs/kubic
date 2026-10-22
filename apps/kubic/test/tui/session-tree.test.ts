// The session's branches as the tree's entries: stitched at their fork
// points, the lane's last entry current, each stored entry's kind, text and
// state, and the one-line tool calls.
import type { SessionTree } from '@kubic/agent/lane/branches';
import type { EntryRecord } from '@kubic/agent/pi-boundary';
import { describe, expect, it } from 'vitest';
import {
  sessionTreeEntries,
  toolCallText,
} from '../../src/tui/session-tree.js';

function record(
  id: number,
  branch: number,
  kind: string,
  model?: unknown,
  data?: unknown,
): EntryRecord {
  return {
    id,
    conversationId: branch,
    kind,
    ...(model === undefined ? {} : { model: [model] }),
    ...(data === undefined ? {} : { data }),
  } as unknown as EntryRecord;
}

const user = (id: number, branch: number, text: string) =>
  record(id, branch, 'pi.user', { role: 'user', content: text });
const reply = (id: number, branch: number, content: unknown, extra = {}) =>
  record(id, branch, 'pi.assistant', { role: 'assistant', content, ...extra });

describe('the tree’s entries', () => {
  it('stitches a fork to the entry it forked at, and marks the lane’s last entry', () => {
    const tree: SessionTree = {
      lane: 2,
      branches: [
        {
          id: 1,
          entries: [
            user(1, 1, 'first'),
            reply(2, 1, 'one'),
            user(3, 1, 'second'),
          ],
        },
        { id: 2, parent: { branch: 1, at: 2 }, entries: [user(4, 2, 'again')] },
      ],
      labels: { '2': { text: 'keep', at: '2026-10-10T05:00:00.000Z' } },
    };
    const shown = sessionTreeEntries(tree);
    expect(shown.entries.map((entry) => [entry.id, entry.parentId])).toEqual([
      ['1', null],
      ['2', '1'],
      ['3', '2'],
      ['4', '2'],
    ]);
    expect(shown.currentId).toBe('4');
    expect(shown.branchOf.get('3')).toBe(1);
    expect(shown.branchOf.get('4')).toBe(2);
    expect(shown.entries[1]).toMatchObject({
      label: 'keep',
      labelAt: '2026-10-10T05:00:00.000Z',
    });
  });

  it('puts an empty fork’s lane at the entry it forked at', () => {
    const tree: SessionTree = {
      lane: 2,
      branches: [
        { id: 1, entries: [user(1, 1, 'first'), reply(2, 1, 'one')] },
        { id: 2, parent: { branch: 1, at: 1 }, entries: [] },
      ],
      labels: {},
    };
    expect(sessionTreeEntries(tree).currentId).toBe('1');
  });

  it('reads each kind of stored entry', () => {
    const tree: SessionTree = {
      lane: 1,
      branches: [
        {
          id: 1,
          entries: [
            user(1, 1, 'list it'),
            record(2, 1, 'pi.system', { role: 'system', content: '' }),
            reply(3, 1, [
              {
                type: 'toolCall',
                id: 'c1',
                name: 'bash',
                arguments: { command: 'ls -la' },
              },
            ]),
            record(4, 1, 'pi.tool-result', {
              role: 'toolResult',
              toolCallId: 'c1',
              toolName: 'bash',
              content: [{ type: 'text', text: 'a.txt' }],
            }),
            reply(5, 1, [], { stopReason: 'aborted' }),
            reply(6, 1, [], {
              stopReason: 'error',
              errorMessage: 'rate\nlimited',
            }),
            record(
              7,
              1,
              'pi.compaction',
              { role: 'user', content: 'summary' },
              { reason: 'manual' },
            ),
            record(8, 1, 'kubic.note'),
          ],
        },
      ],
      labels: {},
    };
    const facts = sessionTreeEntries(tree).entries.map(
      ({ kind, text, state }) => ({ kind, text, ...(state ? { state } : {}) }),
    );
    expect(facts).toEqual([
      { kind: 'user', text: 'list it' },
      { kind: 'system', text: '' },
      { kind: 'assistant', text: '', state: 'empty' },
      { kind: 'tool', text: 'bash: ls -la' },
      { kind: 'assistant', text: '', state: 'aborted' },
      { kind: 'assistant', text: 'rate limited', state: 'error' },
      { kind: 'compaction', text: 'manual' },
      { kind: 'custom', text: 'kubic.note' },
    ]);
  });
});

describe('a tool call on one line', () => {
  it('names the file a file tool touched, home as ~', () => {
    expect(
      toolCallText(
        { name: 'read', args: { path: '/home/me/a.ts' } },
        '/home/me',
      ),
    ).toBe('read: ~/a.ts');
    expect(
      toolCallText(
        { name: 'read', args: { path: 'a.ts', offset: 10, limit: 5 } },
        '',
      ),
    ).toBe('read: a.ts:10-14');
    expect(toolCallText({ name: 'edit', args: { path: 'b.ts' } }, '')).toBe(
      'edit: b.ts',
    );
  });

  it('cuts a long command and shows other tools’ arguments', () => {
    const long = `echo ${'x'.repeat(80)}`;
    expect(toolCallText({ name: 'bash', args: { command: long } }, '')).toBe(
      `bash: ${long.slice(0, 50)}…`,
    );
    expect(
      toolCallText(
        { name: 'grep', args: { pattern: 'TODO', path: 'src' } },
        '',
      ),
    ).toBe('grep: /TODO/ in src');
    expect(toolCallText({ name: 'custom', args: { a: 1 } }, '')).toBe(
      'custom: {"a":1}',
    );
  });
});
