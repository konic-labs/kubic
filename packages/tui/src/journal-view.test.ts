// Slice B RED: JournalView file→hunks + path/agent filters (issue #25).
// Filters mirror `kubic diff --path/--agent` (host journal-cli.ts over
// exec diffEntries): exact match on path and agent. The flattened text
// of a 2-file view equals `kubic diff` output line-for-line (the view
// emits the CLI-identical ---/+++/attribution/hunk blocks; the op label
// lives on the DiffView header, which the CLI does not print).
// Headless snapshots render directly (no VirtualTerminal in Pi 0.85.1).
import { describe, expect, it } from 'vitest';
import type { DiffFileChange } from './diff-view.js';
import {
  filterJournalChanges,
  JournalView,
  renderJournalLines,
} from './journal-view.js';

function changes(): DiffFileChange[] {
  return [
    {
      path: 'a.txt',
      op: 'write',
      agentId: 'root',
      toolCallId: 'call-1',
      sessionId: 's1',
      timestamp: 100,
      unattributed: false,
      reversible: true,
      before: 'one\ntwo\nthree\n',
      after: 'one\nTWO\nthree\n',
    },
    {
      path: 'b.txt',
      op: 'create',
      agentId: 'worker-1',
      toolCallId: 'call-2',
      sessionId: 's1',
      timestamp: 200,
      unattributed: false,
      reversible: false,
      before: null,
      after: 'new\n',
    },
    {
      path: 'c.txt',
      op: 'write',
      agentId: 'root',
      toolCallId: null,
      sessionId: 's1',
      timestamp: 300,
      unattributed: true,
      reversible: false,
      before: null,
      after: 'mystery\n',
    },
  ];
}

describe('journal filters (issue #25; mirrors `kubic diff`)', () => {
  it('narrows by path exactly like --path', () => {
    expect(
      filterJournalChanges(changes(), { path: 'b.txt' }).map((c) => c.path),
    ).toEqual(['b.txt']);
  });

  it('narrows by agent exactly like --agent', () => {
    expect(
      filterJournalChanges(changes(), { agent: 'worker-1' }).map((c) => c.path),
    ).toEqual(['b.txt']);
  });

  it('empty filter keeps every file; unknown values match nothing', () => {
    expect(filterJournalChanges(changes(), {}).length).toBe(3);
    expect(filterJournalChanges(changes(), { path: 'nope' })).toEqual([]);
    expect(filterJournalChanges(changes(), { agent: 'nobody' })).toEqual([]);
  });
});

describe('journal view (issue #25; §80)', () => {
  it('2-file text snapshot equals `kubic diff` text line-for-line', () => {
    const text = renderJournalLines(changes().slice(0, 2)).join('\n');
    expect(text).toBe(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '# agent=root toolCall=call-1',
        '@@ -1,4 +1,4 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        ' ',
        '--- a/b.txt',
        '+++ b/b.txt',
        '# agent=worker-1 toolCall=call-2 [non-reversible]',
        '@@ -1,1 +1,2 @@',
        '+new',
        ' ',
      ].join('\n'),
    );
  });

  it('reconciliation-only entry shows the unattributed badge', () => {
    const text = renderJournalLines(changes().slice(2)).join('\n');
    expect(text).toContain('unattributed');
    expect(text).toContain('agent=root toolCall=none');
  });

  it('binary/missing blob renders a placeholder, never crashes', () => {
    const bad: DiffFileChange = {
      ...changes()[0],
      path: 'bin.dat',
      after: 'a\0b',
    };
    const text = renderJournalLines([bad]).join('\n');
    expect(text).toContain('binary');
    const view = new JournalView([bad]);
    expect(view.render(80).join('\n')).toContain('binary');
  });

  it('empty journal renders the no-changes line', () => {
    expect(renderJournalLines([])).toEqual(['no changes']);
    expect(new JournalView([]).render(80).join('\n')).toContain('no changes');
  });

  it('headless JournalView snapshot lists every file with hunks', () => {
    const view = new JournalView(changes().slice(0, 2));
    const doc = view.render(100).join('\n');
    expect(doc).toContain('--- a/a.txt');
    expect(doc).toContain('--- a/b.txt');
    expect(doc).toContain('+TWO');
    expect(doc).toContain('+new');
  });

  it('view-level filters narrow the snapshot identically to the CLI', () => {
    const view = new JournalView(changes(), { filter: { agent: 'root' } });
    const doc = view.render(100).join('\n');
    expect(doc).toContain('a.txt');
    expect(doc).not.toContain('b.txt');
  });
});

describe('journal mutation hardening (issue #68)', () => {
  it('combines path and agent filters with AND', () => {
    expect(
      filterJournalChanges(changes(), { path: 'a.txt', agent: 'root' }).map(
        (c) => c.path,
      ),
    ).toEqual(['a.txt']);
    expect(
      filterJournalChanges(changes(), { path: 'a.txt', agent: 'worker-1' }),
    ).toEqual([]);
  });

  it('setChanges repaints the snapshot to the new file set', () => {
    const view = new JournalView(changes().slice(0, 1));
    expect(view.render(100).join('\n')).toContain('--- a/a.txt');
    view.setChanges(changes().slice(1, 2));
    const doc = view.render(100).join('\n');
    expect(doc).toContain('--- a/b.txt');
    expect(doc).not.toContain('--- a/a.txt');
  });

  it('empty changes after setChanges renders no-changes', () => {
    const view = new JournalView(changes().slice(0, 1));
    view.setChanges([]);
    expect(view.render(80).join('\n')).toContain('no changes');
  });

  it('setFilter repaints the snapshot to the narrowed set', () => {
    const view = new JournalView(changes());
    expect(view.render(100).join('\n')).toContain('--- a/b.txt');
    view.setFilter({ agent: 'worker-1' });
    const doc = view.render(100).join('\n');
    expect(doc).toContain('--- a/b.txt');
    expect(doc).not.toContain('--- a/a.txt');
  });
});
