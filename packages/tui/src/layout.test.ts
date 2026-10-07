// VStack root — tree / transcript / editor / status rows.
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// root VStack directly (Component.render is pure) and assert row counts,
// order, widths, and the narrow collapse. Alt-screen boot/stop is covered
// with a fake Terminal capturing writes (CSI 2026 + restore).
import { describe, expect, it } from 'vitest';
import { buildLayoutRoot, NARROW_COLUMNS, renderLayout } from './layout.js';
import { Text } from './tui-boundary.js';

function slots(): {
  tree: Text;
  transcript: Text;
  status: Text;
  editor: Text;
} {
  return {
    tree: new Text('tree'),
    transcript: new Text('body'),
    status: new Text('status'),
    editor: new Text('editor'),
  };
}

describe('tui layout root', () => {
  it('orders tree / transcript / editor / status top to bottom', () => {
    const s = slots();
    const root = buildLayoutRoot(s);
    const rows = renderLayout(root, 100);
    expect(rows.length).toBeGreaterThan(0);
    const doc = rows.join('\n');
    const order = ['tree', 'body', 'editor', 'status'].map((m) =>
      doc.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts the notice above the editor and the hints at the bottom', () => {
    const rows = renderLayout(
      buildLayoutRoot({
        ...slots(),
        header: new Text('head', 0, 0),
        notice: new Text('notice', 0, 0),
        hints: new Text('hints', 0, 0),
      }),
      100,
    )
      .map((row) => row.trim())
      .filter((row) => row !== '');
    expect(rows).toEqual([
      'head',
      'tree',
      'body',
      'notice',
      'editor',
      'status',
      'hints',
    ]);
  });

  it('gives an empty notice no row and hides a tree the caller turned off', () => {
    const empty = { render: (): string[] => [], invalidate: (): void => {} };
    const plain = (extra: object): string[] =>
      renderLayout(
        buildLayoutRoot({
          tree: new Text('tree', 0, 0),
          transcript: new Text('body', 0, 0),
          status: new Text('status', 0, 0),
          editor: new Text('editor', 0, 0),
          ...extra,
        }),
        100,
      );
    expect(plain({ notice: empty })).toEqual(plain({}));
    let open = false;
    const toggled = (): string => plain({ treeVisible: () => open }).join('\n');
    expect(toggled()).not.toContain('tree');
    open = true;
    expect(toggled()).toContain('tree');
  });

  it('collapses the tree below 80 columns without overflow', () => {
    const s = slots();
    const wide = renderLayout(buildLayoutRoot(s), 100);
    expect(wide.join('\n')).toContain('tree');
    const narrow = renderLayout(buildLayoutRoot(s), 70);
    expect(narrow.join('\n')).not.toContain('tree');
    expect(narrow.join('\n')).toContain('body');
    for (const line of narrow) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(70);
    }
    expect(NARROW_COLUMNS).toBe(80);
  });

  it('keeps every line within the width at 100 and 70 columns', () => {
    for (const width of [100, 70]) {
      for (const line of renderLayout(buildLayoutRoot(slots()), width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('tui layout boundary (mutation hardening)', () => {
  it('keeps the tree visible at exactly 80 columns, hides at 79', () => {
    expect(renderLayout(buildLayoutRoot(slots()), 80).join('\n')).toContain(
      'tree',
    );
    const narrow = renderLayout(buildLayoutRoot(slots()), 79);
    expect(narrow.join('\n')).not.toContain('tree');
    expect(narrow.join('\n')).toContain('body');
  });
});

function visibleWidth(line: string): number {
  // Strip SGR sequences; OSC8 hyperlinks are reset.
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return line.replace(sgr, '').length;
}
