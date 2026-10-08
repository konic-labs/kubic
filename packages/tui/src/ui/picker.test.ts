// The grouped picker list: group
// headers with a key status, disabled groups and rows, folding, filtering
// and a footer row — the bare /model, /resume, /theme and /thinking pickers.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { visibleWidth } from '../tui-boundary.js';
import {
  createPicker,
  expandPickerGroup,
  movePicker,
  type PickerGroup,
  type PickerState,
  renderPicker,
  selectedPickerRow,
  setPickerQuery,
} from './picker.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const bedrock: PickerGroup = {
  id: 'amazon-bedrock',
  title: 'amazon bedrock',
  status: { text: '● key from AWS_PROFILE', ok: true },
  unit: 'models',
  rows: Array.from({ length: 12 }, (_, i) => ({
    value: `amazon-bedrock/m${i}`,
    text: `m${i}`,
    match: `amazon-bedrock/m${i}`,
  })),
};

const GROUPS: PickerGroup[] = [
  {
    id: 'anthropic',
    title: 'anthropic',
    status: { text: '● key from ANTHROPIC_API_KEY', ok: true },
    rows: [
      {
        value: 'anthropic/claude-sonnet-5-5',
        text: 'claude-sonnet-5-5',
        match: 'anthropic/claude-sonnet-5-5',
        current: true,
        right: '200k ctx · thinking',
      },
      {
        value: 'anthropic/claude-opus-5-5',
        text: 'claude-opus-5-5',
        match: 'anthropic/claude-opus-5-5',
        right: '1M ctx · thinking',
      },
    ],
  },
  bedrock,
  {
    id: 'openai',
    title: 'openai',
    status: { text: '○ no key', ok: false },
    right: 'set OPENAI_API_KEY',
    disabled: true,
    rows: [{ value: 'openai/gpt-5', text: 'gpt-5', match: 'openai/gpt-5' }],
  },
];

const render = (state: PickerState, width = 72, footer?: string[]): string[] =>
  renderPicker(plain, state, width, {
    title: 'Model',
    input: state.query,
    maxRows: 40,
    ...(footer === undefined ? {} : { footer }),
  });

describe('picker list', () => {
  it('starts on the current row and reads like the design', () => {
    const state = createPicker(GROUPS);
    expect(selectedPickerRow(state)?.value).toBe('anthropic/claude-sonnet-5-5');
    expect(render(state)).toEqual([
      '┌─ Model ──────────────────────────────────────────────────────────────┐',
      '│ ›                                                     type to filter │',
      '├──────────────────────────────────────────────────────────────────────┤',
      '│ ANTHROPIC  ● key from ANTHROPIC_API_KEY                              │',
      '│▌● claude-sonnet-5-5  current                     200k ctx · thinking │',
      '│   claude-opus-5-5                                  1M ctx · thinking │',
      '│                                                                      │',
      '│ AMAZON BEDROCK  ● key from AWS_PROFILE                     12 models │',
      '│   ▸ expand (→)                                                       │',
      '│                                                                      │',
      '│ OPENAI  ○ no key                                  set OPENAI_API_KEY │',
      '└──────────────────────────────────────────────────────────────────────┘',
    ]);
  });

  it('moves over the rows it can choose, the expand row included', () => {
    const state = createPicker(GROUPS);
    const opus = movePicker(state, 1);
    expect(selectedPickerRow(opus)?.value).toBe('anthropic/claude-opus-5-5');
    const expand = movePicker(opus, 1);
    expect(selectedPickerRow(expand)).toBeUndefined();
    // The keyless group is never a stop: down from the expand row wraps.
    expect(selectedPickerRow(movePicker(expand, 1))?.value).toBe(
      'anthropic/claude-sonnet-5-5',
    );
  });

  it('expands a folded group in place', () => {
    const state = movePicker(createPicker(GROUPS), 2);
    const open = expandPickerGroup(state);
    expect(selectedPickerRow(open)?.value).toBe('amazon-bedrock/m0');
    expect(render(open).join('\n')).toContain('│   m11 ');
    expect(render(open).join('\n')).not.toContain('expand (→)');
  });

  it('filters by the query across folded groups, keyless groups too', () => {
    const state = setPickerQuery(createPicker(GROUPS), 'm11');
    expect(selectedPickerRow(state)?.value).toBe('amazon-bedrock/m11');
    const lines = render(state);
    expect(lines.join('\n')).not.toContain('ANTHROPIC');
    expect(lines.join('\n')).toContain('│▌  m11');
    expect(lines[1]).toContain('1 result');
    // A keyless provider still shows when its name matches — rows hidden.
    const openai = render(setPickerQuery(createPicker(GROUPS), 'openai'));
    expect(openai.join('\n')).toContain('OPENAI  ○ no key');
    expect(openai.join('\n')).not.toContain('gpt-5');
  });

  it('stacks keyless providers one header per row', () => {
    const keyless = (id: string): PickerGroup => ({
      id,
      title: id,
      status: { text: '○ no key', ok: false },
      disabled: true,
      rows: [],
    });
    const lines = render(
      createPicker([...GROUPS, keyless('openrouter'), keyless('groq')]),
    );
    const at = lines.findIndex((line) => line.includes('OPENAI'));
    expect(lines[at + 1]).toContain('OPENROUTER  ○ no key');
    expect(lines[at + 2]).toContain('GROQ  ○ no key');
  });

  it('greys a disabled row and never selects it', () => {
    const sessions: PickerGroup[] = [
      {
        id: 'sessions',
        rows: [
          { value: 'a', text: 'fix the cart', right: '2m ago · 4 turns' },
          {
            value: 'b',
            text: 'old session',
            disabled: true,
            note: 'in use by another kubic',
          },
        ],
      },
    ];
    const state = movePicker(createPicker(sessions), 1);
    expect(selectedPickerRow(state)?.value).toBe('a');
    const lines = render(state);
    expect(lines).toContain(
      '│▌  fix the cart                                      2m ago · 4 turns │',
    );
    expect(lines.join('\n')).toContain('old session  in use by another kubic');
    const painted = renderPicker(rich, state, 72, {
      title: 'Session',
      input: '',
      maxRows: 20,
    });
    expect(painted.find((line) => line.includes('old session'))).toContain(
      rich.fg('fg3')('   old session  in use by another kubic'),
    );
  });

  it('closes with a footer row under its own rule', () => {
    const lines = render(createPicker(GROUPS), 72, [
      ' thinking  off  low  med  high  max',
    ]);
    expect(lines.at(-3)?.startsWith('├')).toBe(true);
    expect(lines.at(-2)).toContain('thinking  off');
    for (const line of lines) expect(visibleWidth(line)).toBe(72);
  });

  it('keeps the selection in view on a short terminal', () => {
    const state = movePicker(
      expandPickerGroup(movePicker(createPicker(GROUPS), 2)),
      11,
    );
    expect(selectedPickerRow(state)?.value).toBe('amazon-bedrock/m11');
    const lines = renderPicker(plain, state, 72, {
      title: 'Model',
      input: '',
      maxRows: 10,
    });
    expect(lines).toHaveLength(10);
    expect(lines.join('\n')).toContain('▌  m11');
  });
});
