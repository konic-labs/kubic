// The block viewer: one block whole in a framed,
// scrolling overlay with copy and close.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { BlockViewer } from './block-viewer.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

function viewer(rows: number, maxRows = 8) {
  const events: string[] = [];
  const view = new BlockViewer({
    title: 'bash npm test',
    lines: () => Array.from({ length: rows }, (_, i) => `row ${i + 1}`),
    maxRows: () => maxRows,
    onCopy: () => events.push('copy'),
    onClose: () => events.push('close'),
    ui: () => plain,
  });
  return { view, events };
}

describe('block viewer', () => {
  it('frames the block and says where it is', () => {
    const { view } = viewer(20);
    const lines = view.render(40);
    expect(lines[0]).toContain('┌─ bash npm test');
    expect(lines[0]).toContain('1–5 of 20');
    expect(lines[1]).toBe('│ row 1                                │');
    expect(lines.at(-1)).toContain('↑↓ scroll   y copy   esc close');
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
  });

  it('scrolls by row, page and end, never past the content', () => {
    const { view } = viewer(20);
    view.render(40);
    view.handleInput('j');
    expect(view.render(40)[1]).toContain('row 2');
    view.handleInput('\u001b[6~');
    expect(view.render(40)[1]).toContain('row 7');
    view.handleInput('G');
    expect(view.render(40)[0]).toContain('16–20 of 20');
    view.handleInput('j');
    expect(view.render(40)[0]).toContain('16–20 of 20');
    view.handleInput('g');
    expect(view.render(40)[1]).toContain('row 1');
  });

  it('copies and closes', () => {
    const { view, events } = viewer(3);
    expect(view.render(40)[0]).toContain('3 rows');
    view.handleInput('y');
    view.handleInput('\u001b');
    expect(events).toEqual(['copy', 'close']);
  });
});
