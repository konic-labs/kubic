// The session tree drawn and driven: the header's key hints, the rows'
// connectors and marks, the position line, panning, and the keys through the
// registry (move, select, search, filters, label, copy). Plain text at depth
// none reads like the design.
import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEY_REGISTRY } from './keybindings.js';
import { SessionTreeState, type TreeEntryLike } from './session-tree.js';
import {
  formatLabelTime,
  renderTreeHeader,
  renderTreeRows,
} from './session-tree-render.js';
import {
  SessionTreeView,
  type SessionTreeViewOptions,
} from './session-tree-view.js';
import { parseKey, visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

const UP = '\x1b[A';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_U = '\x15';
const CTRL_X = '\x18';

function entry(
  id: string,
  parentId: string | null,
  kind: TreeEntryLike['kind'],
): TreeEntryLike {
  return { id, parentId, kind, text: `text ${id}`, copyText: `full ${id}` };
}

// 1 → 2 → (3 → 4) | (5 → 6), the session at 6.
const BRANCHED: TreeEntryLike[] = [
  entry('1', null, 'user'),
  entry('2', '1', 'assistant'),
  entry('3', '2', 'user'),
  entry('4', '3', 'assistant'),
  entry('5', '2', 'user'),
  entry('6', '5', 'assistant'),
];

function view(over: Partial<SessionTreeViewOptions> = {}) {
  const calls = {
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    onCopy: vi.fn(),
    onLabel: vi.fn(),
  };
  const tree = new SessionTreeView({
    entries: BRANCHED,
    currentId: '6',
    maxVisible: 10,
    keys: DEFAULT_KEY_REGISTRY,
    ...calls,
    ...over,
  });
  const press = (data: string): void => tree.handleKey(data, parseKey(data));
  const lines = (): string[] => tree.render(plain, 120);
  return { tree, press, lines, ...calls };
}

describe('the tree drawn', () => {
  it('draws the header: a rule, the title, the keys and the search', () => {
    const header = renderTreeHeader(
      plain,
      40,
      [{ keys: '↑/↓', label: 'move' }],
      'pars',
    );
    expect(header).toEqual([
      '',
      '─'.repeat(40),
      '   Session tree',
      '  ↑/↓ move',
      '  Type to search: pars',
      '─'.repeat(40),
    ]);
  });

  it('hints the keys the registry binds, compacted as pi writes them', () => {
    expect(view().lines()).toContain(
      '  ↑/↓ move · ←/→ page · alt+←/→ branch · ^X copy · L label · T label time · filters ^D/T/U/L/A · cycle ^O/^⇧O',
    );
  });

  it('draws connectors, fold marks, gutters and the path to the current entry', () => {
    const state = new SessionTreeState(BRANCHED, '6', { maxVisible: 10 });
    expect(renderTreeRows(plain, state, 60)).toEqual([
      '  • user: text 1',
      '  • assistant: text 2',
      '  ├⊟ • user: text 5',
      '› │     • assistant: text 6',
      '  └⊟ user: text 3',
      '        assistant: text 4',
      '  (4/6)',
    ]);
  });

  it('says so when nothing shows, with the filter in force', () => {
    const state = new SessionTreeState(BRANCHED, '6', {
      maxVisible: 10,
      filter: 'labeled-only',
    });
    expect(renderTreeRows(plain, state, 60)).toEqual([
      '  No entries found',
      '  (0/0) [labeled]',
    ]);
  });

  it('pans a deep selection so its text stays in view', () => {
    // A branch at every level: the selected row sits far to the right.
    const deep: TreeEntryLike[] = [entry('a0', null, 'user')];
    for (let level = 1; level <= 7; level += 1) {
      deep.push(entry(`a${level}`, `a${level - 1}`, 'user'));
      deep.push(entry(`b${level}`, `a${level - 1}`, 'user'));
    }
    const state = new SessionTreeState(deep, 'a7', { maxVisible: 20 });
    const selected = renderTreeRows(plain, state, 24).find((line) =>
      line.startsWith('›'),
    );
    expect(selected).toContain('user:');
    expect(visibleWidth(selected ?? '')).toBeLessThanOrEqual(24);
  });

  it('writes when a label was set: the time today, the day this year, the year before', () => {
    const now = new Date(2026, 9, 10, 12, 0);
    expect(
      formatLabelTime(new Date(2026, 9, 10, 9, 5).toISOString(), now),
    ).toBe('09:05');
    expect(
      formatLabelTime(new Date(2026, 2, 7, 14, 5).toISOString(), now),
    ).toBe('3/7 14:05');
    expect(
      formatLabelTime(new Date(2024, 2, 7, 14, 5).toISOString(), now),
    ).toBe('24/3/7 14:05');
  });
});

describe('the tree driven', () => {
  it('moves with the arrows and hands the chosen entry over on Enter', () => {
    const tree = view();
    tree.press(UP);
    tree.press(ENTER);
    expect(tree.onSelect).toHaveBeenCalledWith(BRANCHED[4]);
  });

  it('searches as it is typed; Esc clears the search, then closes', () => {
    const tree = view();
    for (const ch of 'text 3') tree.press(ch);
    expect(tree.lines()).toContain('  Type to search: text 3');
    expect(tree.tree.state.rows.map((row) => row.id)).toEqual(['3']);
    tree.press(ESC);
    expect(tree.tree.state.rows).toHaveLength(6);
    expect(tree.onCancel).not.toHaveBeenCalled();
    tree.press(ESC);
    expect(tree.onCancel).toHaveBeenCalledTimes(1);
  });

  it('switches the filter on its key and back on the same key', () => {
    const tree = view();
    tree.press(CTRL_U);
    expect(tree.tree.state.filter).toBe('user-only');
    expect(tree.lines().some((line) => line.endsWith('[user]'))).toBe(true);
    tree.press(CTRL_U);
    expect(tree.tree.state.filter).toBe('default');
  });

  it('labels the selected entry in place, and keeps a cancelled label out', () => {
    const tree = view();
    tree.press('L');
    expect(tree.lines()).toContain('  Label (empty to remove):');
    for (const ch of 'keep') tree.press(ch);
    tree.press(ESC);
    expect(tree.onLabel).not.toHaveBeenCalled();
    tree.press('L');
    for (const ch of 'keep') tree.press(ch);
    tree.press(ENTER);
    expect(tree.onLabel).toHaveBeenCalledWith('6', 'keep');
    expect(
      tree.lines().some((line) => line.includes('[keep] assistant:')),
    ).toBe(true);
  });

  it('copies the selected entry’s full text', () => {
    const tree = view();
    tree.press(CTRL_X);
    expect(tree.onCopy).toHaveBeenCalledWith('full 6');
  });
});
