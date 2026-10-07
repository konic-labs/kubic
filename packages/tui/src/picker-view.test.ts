// The "choose one" overlay: filtering through Pi's
// Input, moving, expanding a folded group, the side control and choosing.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import { PickerView } from './picker-view.js';
import type { PickerGroup } from './ui/picker.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

const GROUPS: PickerGroup[] = [
  {
    id: 'faux',
    title: 'faux',
    rows: [
      { value: 'faux/big', text: 'big', match: 'faux/big', current: true },
      { value: 'faux/small', text: 'small', match: 'faux/small' },
    ],
  },
  {
    id: 'wide',
    title: 'wide',
    unit: 'models',
    rows: Array.from({ length: 9 }, (_, i) => ({
      value: `wide/m${i}`,
      text: `m${i}`,
      match: `wide/m${i}`,
    })),
  },
];

function view() {
  const chosen: string[] = [];
  const moves: string[] = [];
  const sides: number[] = [];
  let closed = 0;
  const picker = new PickerView({
    title: 'Model',
    groups: GROUPS,
    maxRows: () => 30,
    onSelect: (row) => chosen.push(row.value),
    onClose: () => {
      closed += 1;
    },
    onMove: (row) => moves.push(row?.value ?? '(expand)'),
    onSide: (direction) => sides.push(direction),
    footer: () => [' thinking  off  [high]'],
    ui: () => plain,
  });
  return { picker, chosen, moves, sides, closed: () => closed };
}

describe('picker view', () => {
  it('starts on the current row and chooses with enter', () => {
    const { picker, chosen } = view();
    picker.handleInput('\r');
    expect(chosen).toEqual(['faux/big']);
    const frame = picker.render(60).join('\n');
    expect(frame).toContain('┌─ Model');
    expect(frame).toContain('thinking  off  [high]');
  });

  it('moves, opens a folded group with → or enter, and reports moves', () => {
    const { picker, chosen, moves, sides } = view();
    picker.handleInput('\x1b[B');
    picker.handleInput('\x1b[B');
    expect(picker.selected()).toBeUndefined();
    picker.handleInput('\x1b[C');
    expect(picker.selected()?.value).toBe('wide/m0');
    expect(sides).toEqual([]);
    picker.handleInput('\x1b[C');
    picker.handleInput('\x1b[D');
    expect(sides).toEqual([1, -1]);
    picker.handleInput('\r');
    expect(chosen).toEqual(['wide/m0']);
    expect(moves).toEqual(['faux/small', '(expand)', 'wide/m0']);
  });

  it('filters as it is typed and closes on esc', () => {
    const { picker, closed } = view();
    for (const ch of 'small') picker.handleInput(ch);
    expect(picker.getState().query).toBe('small');
    expect(picker.selected()?.value).toBe('faux/small');
    expect(picker.render(60).join('\n')).toContain('1 result');
    picker.handleInput('\x1b');
    expect(closed()).toBe(1);
  });
});
