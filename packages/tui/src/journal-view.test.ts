// JournalView file→hunks + path filter.
// The path filter mirrors `kubic diff --path` (host journal-cli.ts over
// exec diffEntries): exact match on path. The snapshots here pin the layout
// exec's renderDiff prints (---/+++, the `# toolCall=` marker, hunks). They
// check the view's own copy, since this package cannot import exec. The op
// label lives on the op-labelled header, which the CLI does not print.
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

describe('journal filters (mirrors `kubic diff`)', () => {
  it('narrows by path exactly like --path', () => {
    expect(
      filterJournalChanges(changes(), { path: 'b.txt' }).map((c) => c.path),
    ).toEqual(['b.txt']);
  });

  it('empty filter keeps every file; unknown values match nothing', () => {
    expect(filterJournalChanges(changes(), {}).length).toBe(3);
    expect(filterJournalChanges(changes(), { path: 'nope' })).toEqual([]);
  });
});

describe('journal view', () => {
  it('2-file text snapshot pins the layout kubic diff prints', () => {
    const text = renderJournalLines(changes().slice(0, 2)).join('\n');
    expect(text).toBe(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '# toolCall=call-1',
        '@@ -1,4 +1,4 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        ' ',
        '--- a/b.txt',
        '+++ b/b.txt',
        '# toolCall=call-2 [non-reversible]',
        '@@ -1,1 +1,2 @@',
        '+new',
        ' ',
      ].join('\n'),
    );
  });

  it('reconciliation-only entry shows the unattributed badge', () => {
    // A reconciliation-only write has no pre-image: the badge names it and
    // the hunk is replaced by the missing-blob placeholder.
    expect(renderJournalLines(changes().slice(2))).toEqual([
      '--- a/c.txt',
      '+++ b/c.txt',
      '# toolCall=none [unattributed, non-reversible]',
      '~ content unavailable: c.txt (missing before-blob)',
    ]);
  });

  it('binary/missing blob renders a placeholder, never crashes', () => {
    const bad: DiffFileChange = {
      ...changes()[0],
      path: 'bin.dat',
      after: 'a\0b',
    };
    const placeholder = '~ binary content not shown: bin.dat';
    expect(renderJournalLines([bad])).toEqual([
      '--- a/bin.dat',
      '+++ b/bin.dat',
      '# toolCall=call-1',
      placeholder,
    ]);
    const view = new JournalView([bad]);
    expect(view.render(80).join('\n')).toContain(placeholder);
    const missing: DiffFileChange = { ...changes()[0], after: null };
    expect(renderJournalLines([missing]).at(-1)).toBe(
      '~ content unavailable: a.txt (missing after-blob)',
    );
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

  it('view-level path filter narrows the snapshot the way --path does', () => {
    const view = new JournalView(changes(), { filter: { path: 'a.txt' } });
    const doc = view.render(100).join('\n');
    expect(doc).toContain('--- a/a.txt');
    expect(doc).not.toContain('--- a/c.txt');
    expect(doc).not.toContain('b.txt');
  });
});

describe('journal view exact rendering', () => {
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
    view.setFilter({ path: 'b.txt' });
    const doc = view.render(100).join('\n');
    expect(doc).toContain('--- a/b.txt');
    expect(doc).not.toContain('--- a/a.txt');
  });
});
