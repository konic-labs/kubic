// The session tree's shape and state: pi's indentation and connectors, the
// filters, the search, folding and how the selection moves.
import { describe, expect, it } from 'vitest';
import {
  SessionTreeState,
  type TreeEntryKind,
  type TreeEntryLike,
} from './session-tree.js';
import { layoutTree } from './session-tree-layout.js';

function entry(
  id: string,
  parentId: string | null,
  kind: TreeEntryKind = 'user',
  over: Partial<TreeEntryLike> = {},
): TreeEntryLike {
  return { id, parentId, kind, text: `text ${id}`, ...over };
}

// 1 user → 2 assistant → (3 user → 4 assistant) | (5 user → 6 assistant)
const BRANCHED: TreeEntryLike[] = [
  entry('1', null),
  entry('2', '1', 'assistant'),
  entry('3', '2'),
  entry('4', '3', 'assistant'),
  entry('5', '2'),
  entry('6', '5', 'assistant'),
];

const ids = (state: SessionTreeState): string[] =>
  state.rows.map((row) => row.id);

describe('the tree layout', () => {
  it('keeps a chain of single children flat', () => {
    const layout = layoutTree(
      BRANCHED.slice(0, 4),
      new Set(['1', '2', '3', '4']),
      new Set(),
    );
    expect(
      layout.rows.map((row) => [row.id, row.indent, row.showConnector]),
    ).toEqual([
      ['1', 0, false],
      ['2', 0, false],
      ['3', 0, false],
      ['4', 0, false],
    ]);
  });

  it('steps a branch point’s children in, with connectors and a gutter', () => {
    const all = new Set(BRANCHED.map((node) => node.id));
    const layout = layoutTree(BRANCHED, all, new Set(['1', '2', '5', '6']));
    // The branch holding the current entry (5 → 6) comes first.
    expect(layout.rows.map((row) => row.id)).toEqual([
      '1',
      '2',
      '5',
      '6',
      '3',
      '4',
    ]);
    const byId = new Map(layout.rows.map((row) => [row.id, row]));
    expect(byId.get('5')).toMatchObject({
      indent: 1,
      showConnector: true,
      isLast: false,
    });
    expect(byId.get('3')).toMatchObject({
      indent: 1,
      showConnector: true,
      isLast: true,
    });
    // The first generation after a branch steps in once more, under a gutter
    // that stays open while a sibling follows.
    expect(byId.get('6')).toMatchObject({
      indent: 2,
      showConnector: false,
      gutters: [{ position: 0, show: true }],
    });
    expect(byId.get('4')?.gutters).toEqual([{ position: 0, show: false }]);
  });

  it('hangs several roots off a virtual root that draws no connector', () => {
    const roots = [entry('1', null), entry('2', null)];
    const layout = layoutTree(roots, new Set(['1', '2']), new Set(['2']));
    expect(layout.multipleRoots).toBe(true);
    expect(layout.rows.map((row) => [row.id, row.virtualRootChild])).toEqual([
      ['2', true],
      ['1', true],
    ]);
  });

  it('attaches a row to its nearest visible ancestor when one is hidden', () => {
    const layout = layoutTree(BRANCHED, new Set(['1', '3', '5']), new Set());
    expect(layout.parentOf.get('3')).toBe('1');
    expect(layout.childrenOf.get('1')).toEqual(['3', '5']);
  });
});

describe('the tree state', () => {
  const state = (
    over: Partial<ConstructorParameters<typeof SessionTreeState>[2]> = {},
  ) => new SessionTreeState(BRANCHED, '6', { maxVisible: 3, ...over });

  it('starts on the current entry and marks the path to it', () => {
    const tree = state();
    expect(tree.selected()?.id).toBe('6');
    expect(['1', '2', '5', '6'].every((id) => tree.isOnPath(id))).toBe(true);
    expect(tree.isOnPath('3')).toBe(false);
  });

  it('wraps a step at either end and stops a page at it', () => {
    const tree = state({ selectedId: '1' });
    tree.step(-1);
    expect(tree.selected()?.id).toBe('4');
    tree.step(1);
    expect(tree.selected()?.id).toBe('1');
    tree.page(1);
    expect(tree.selectedIndex).toBe(3);
    tree.page(1);
    expect(tree.selectedIndex).toBe(5);
    tree.page(-1);
    tree.page(-1);
    tree.page(-1);
    expect(tree.selectedIndex).toBe(0);
  });

  it('hides bookkeeping by default and tool-only replies always', () => {
    const tree = new SessionTreeState(
      [
        entry('1', null),
        entry('2', '1', 'system'),
        entry('3', '2', 'assistant', { text: '', state: 'empty' }),
        entry('4', '3', 'tool', { text: 'bash: ls' }),
        entry('5', '4', 'custom', { text: 'kubic.note' }),
        entry('6', '5', 'assistant'),
      ],
      '6',
      { maxVisible: 10 },
    );
    expect(ids(tree)).toEqual(['1', '4', '6']);
    tree.toggleFilter('no-tools');
    expect(ids(tree)).toEqual(['1', '6']);
    // `all` adds the bookkeeping; a reply that only called tools says
    // nothing on any filter (as in pi), its tool result speaks for it.
    tree.toggleFilter('all');
    expect(ids(tree)).toEqual(['1', '2', '4', '5', '6']);
    // The same filter key again is the default.
    tree.toggleFilter('all');
    expect(tree.filter).toBe('default');
  });

  it('cycles the filters both ways and keeps the selection near where it was', () => {
    const tree = state();
    tree.cycleFilter(1);
    expect(tree.filter).toBe('no-tools');
    tree.cycleFilter(1);
    expect(tree.filter).toBe('user-only');
    // The reply 6 is hidden; its prompt 5 is the nearest visible ancestor.
    expect(tree.selected()?.id).toBe('5');
    tree.cycleFilter(-1);
    tree.cycleFilter(-1);
    tree.cycleFilter(-1);
    expect(tree.filter).toBe('all');
  });

  it('searches every word, ignoring case, labels included', () => {
    const tree = new SessionTreeState(
      [
        entry('1', null, 'user', { text: 'Fix the parser' }),
        entry('2', '1', 'assistant', { text: 'done', label: 'Checkpoint' }),
        entry('3', '2', 'user', { text: 'fix the lexer' }),
      ],
      '3',
      { maxVisible: 10 },
    );
    tree.setSearch('FIX lexer');
    expect(ids(tree)).toEqual(['3']);
    tree.setSearch('checkpoint');
    expect(ids(tree)).toEqual(['2']);
    tree.setSearch('');
    expect(ids(tree)).toEqual(['1', '2', '3']);
  });

  it('labels an entry and lists only labelled ones under that filter', () => {
    const tree = state();
    tree.setLabel('3', 'try this', '2026-10-10T05:00:00.000Z');
    expect(tree.entry('3')).toMatchObject({ label: 'try this' });
    tree.toggleFilter('labeled-only');
    expect(ids(tree)).toEqual(['3']);
    tree.setLabel('3', undefined, '2026-10-10T05:01:00.000Z');
    expect(tree.entry('3')?.label).toBeUndefined();
    expect(ids(tree)).toEqual([]);
  });

  it('folds a segment from its start, and goes to the start from inside it', () => {
    const tree = state();
    // 6 is inside the segment that starts at 5: the first press goes there.
    tree.foldOrUp();
    expect(tree.selected()?.id).toBe('5');
    expect(tree.isFoldable('5')).toBe(true);
    tree.foldOrUp();
    expect(tree.isFolded('5')).toBe(true);
    expect(ids(tree)).toEqual(['1', '2', '5', '3', '4']);
    tree.unfoldOrDown();
    expect(ids(tree)).toEqual(['1', '2', '5', '6', '3', '4']);
    // From the top, down goes to the first branch point's first child.
    tree.step(-1);
    tree.step(-1);
    tree.unfoldOrDown();
    expect(tree.selected()?.id).toBe('5');
  });
});
