// The ^P palette's overlay view: the query through
// Pi's Input, navigation and the row actions through the palette state.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { PaletteView } from './palette-view.js';
import type { PaletteItem } from './ui/palette.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

const ITEMS: PaletteItem[] = [
  { group: 'commands', value: '/model', text: '/model', detail: 'switch' },
  { group: 'commands', value: '/help', text: '/help', detail: 'list' },
  { group: 'files', value: 'src/model.ts', text: 'src/model.ts' },
];

function view() {
  const ran: string[] = [];
  let closed = 0;
  const palette = new PaletteView({
    items: ITEMS,
    keyLabel: '^P',
    maxRows: () => 20,
    onRun: (item) => ran.push(item.value),
    onClose: () => {
      closed += 1;
    },
    ui: () => plain,
  });
  return { palette, ran, closed: () => closed };
}

describe('palette view', () => {
  it('types into the query and filters the rows', () => {
    const { palette } = view();
    for (const ch of 'mod') palette.handleInput(ch);
    expect(palette.getState().query).toBe('mod');
    const frame = palette.render(60).join('\n');
    expect(frame).toContain('› mod');
    expect(frame).toContain('2 results');
    expect(frame).not.toContain('/help');
    palette.handleInput('\x7f');
    expect(palette.getState().query).toBe('mo');
  });

  it('moves, focuses groups, runs the selected row and closes', () => {
    const { palette, ran, closed } = view();
    for (const ch of 'mod') palette.handleInput(ch);
    palette.handleInput('\x1b[B');
    palette.handleInput('\r');
    expect(ran).toEqual(['src/model.ts']);
    palette.handleInput('\t');
    expect(palette.getState().focus).toBe('commands');
    palette.handleInput('\r');
    expect(ran).toEqual(['src/model.ts', '/model']);
    palette.handleInput('\x1b[C');
    expect(palette.getState().details).toBe(true);
    palette.handleInput('\x1b');
    expect(closed()).toBe(1);
  });

  it('ignores keys that would move the cursor off the end of the query', () => {
    const { palette } = view();
    for (const ch of 'mo') palette.handleInput(ch);
    palette.handleInput('\x1b[D');
    palette.handleInput('\x01');
    palette.handleInput('d');
    expect(palette.getState().query).toBe('mod');
  });

  it('keeps the selection when more rows arrive', () => {
    const { palette } = view();
    palette.handleInput('\x1b[B');
    palette.setItems([
      ...ITEMS,
      { group: 'sessions', value: 's-1', text: 'session one' },
    ]);
    palette.handleInput('\r');
    expect(palette.getState().selected).toBe(1);
  });
});
