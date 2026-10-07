// The ^P palette's state and render.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { visibleWidth } from '../tui-boundary.js';
import {
  createPalette,
  cyclePaletteGroup,
  formatAge,
  formatContextWindow,
  movePalette,
  PALETTE_GROUP_ROWS,
  type PaletteItem,
  type PaletteState,
  paletteGroups,
  paletteModelMeta,
  paletteResultCount,
  paletteRows,
  renderPalette,
  selectedPaletteItem,
  setPaletteItems,
  setPaletteQuery,
  togglePaletteDetails,
} from './palette.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const COMMANDS: PaletteItem[] = [
  {
    group: 'commands',
    value: '/model',
    text: '/model',
    detail: 'switch the model for this session',
    meta: 'alt+m',
  },
  {
    group: 'commands',
    value: '/models',
    text: '/models',
    detail: "browse every provider's catalogue",
  },
  {
    group: 'commands',
    value: '/mode',
    text: '/mode',
    detail: 'switch the input mode',
    meta: '^G',
  },
  {
    group: 'commands',
    value: '/help',
    text: '/help',
    detail: 'list the commands',
  },
];

const MODELS: PaletteItem[] = [
  {
    group: 'models',
    value: 'anthropic/claude-sonnet-5-5',
    text: 'anthropic/claude-sonnet-5-5',
    current: true,
    meta: paletteModelMeta(200_000, true),
  },
  {
    group: 'models',
    value: 'anthropic/claude-opus-5-5',
    text: 'anthropic/claude-opus-5-5',
    meta: paletteModelMeta(1_000_000, true),
  },
];

const SESSIONS: PaletteItem[] = [
  {
    group: 'sessions',
    value: 's-1',
    text: 'cart-fix · modify addItem',
    meta: '2m ago',
  },
];

const FILES: PaletteItem[] = [
  {
    group: 'files',
    value: 'src/models.js',
    text: 'src/models.js',
    meta: '@ insert',
  },
];

const ALL = [...COMMANDS, ...MODELS, ...SESSIONS, ...FILES];

function query(
  text: string,
  items: readonly PaletteItem[] = ALL,
): PaletteState {
  return setPaletteQuery(createPalette(items), text);
}

function shape(state: PaletteState): Array<[string, string[]]> {
  return paletteGroups(state).map((view) => [
    view.group,
    view.rows.map((row) => row.item.value),
  ]);
}

const render = (state: PaletteState, width = 80, maxRows = 30): string[] =>
  renderPalette(plain, state, width, {
    input: state.query,
    maxRows,
    keyLabel: '^P',
  });

describe('palette state', () => {
  it('groups the matches in order, best first, and hides empty groups', () => {
    const state = query('mod');
    expect(shape(state)).toEqual([
      ['commands', ['/mode', '/model', '/models']],
      ['sessions', ['s-1']],
      ['files', ['src/models.js']],
    ]);
    expect(paletteResultCount(state)).toBe(5);
    // The matched letters, for the accent highlight.
    expect(paletteRows(state)[1]?.positions).toEqual([1, 2, 3]);
  });

  it('ranks a name match above a summary match', () => {
    const items: PaletteItem[] = [
      {
        group: 'commands',
        value: '/journal',
        text: '/journal',
        detail: 'show the session journal',
      },
      { group: 'commands', value: '/session', text: '/session', detail: 'id' },
    ];
    const state = query('session', items);
    expect(paletteRows(state).map((row) => row.item.value)).toEqual([
      '/session',
      '/journal',
    ]);
    expect(paletteRows(state)[1]?.detailPositions).toEqual([
      9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('matches a summary only where the word appears in it', () => {
    // Scattered letters across a sentence (l…a…r…g…e) are noise, not a hit.
    const help: PaletteItem = {
      group: 'commands',
      value: '/help',
      text: '/help',
      detail: 'list the commands, or one command’s usage',
    };
    expect(shape(query('large', [help]))).toEqual([]);
    expect(shape(query('catalogue', COMMANDS))).toEqual([
      ['commands', ['/models']],
    ]);
  });

  it('selects the best match of any group, keeping the group order', () => {
    const items: PaletteItem[] = [
      ...COMMANDS,
      { group: 'files', value: 'help.md', text: 'help.md' },
      { group: 'files', value: 'opus.md', text: 'opus.md' },
    ];
    const state = query('opus', [...items, ...MODELS]);
    expect(shape(state).map(([group]) => group)).toEqual(['models', 'files']);
    expect(selectedPaletteItem(state)?.value).toBe('opus.md');
  });

  it('every word of the query must match', () => {
    expect(shape(query('claude sonnet'))).toEqual([
      ['models', ['anthropic/claude-sonnet-5-5']],
    ]);
    expect(shape(query('claude nothing'))).toEqual([]);
  });

  it('an empty query shows the recent commands and the current model', () => {
    expect(shape(query(''))).toEqual([
      ['commands', ['/model', '/models', '/mode', '/help']],
      ['models', ['anthropic/claude-sonnet-5-5']],
    ]);
    const recent = ALL.map((item) =>
      item.value === '/help' ? { ...item, recent: true } : item,
    );
    expect(shape(query('', recent))[0]).toEqual(['commands', ['/help']]);
  });

  it('caps a group until tab focuses it', () => {
    const files: PaletteItem[] = Array.from({ length: 10 }, (_, i) => ({
      group: 'files',
      value: `f${i}.ts`,
      text: `f${i}.ts`,
    }));
    const state = query('f', files);
    expect(paletteRows(state)).toHaveLength(PALETTE_GROUP_ROWS);
    expect(paletteResultCount(state)).toBe(10);
    const focused = cyclePaletteGroup(state, 1);
    expect(focused.focus).toBe('files');
    expect(paletteRows(focused)).toHaveLength(10);
  });

  it('moves with wrap-around across the groups', () => {
    const state = query('mod');
    expect(selectedPaletteItem(state)?.value).toBe('/mode');
    expect(selectedPaletteItem(movePalette(state, 3))?.value).toBe('s-1');
    expect(selectedPaletteItem(movePalette(state, -1))?.value).toBe(
      'src/models.js',
    );
    expect(selectedPaletteItem(movePalette(state, 5))?.value).toBe('/mode');
  });

  it('tab and shift+tab step through the groups', () => {
    const state = query('');
    const models = cyclePaletteGroup(state, 1);
    // Browsing a focused group lists all of it, the selection on its first row.
    expect(models.focus).toBe('models');
    expect(selectedPaletteItem(models)?.value).toBe(
      'anthropic/claude-sonnet-5-5',
    );
    expect(paletteGroups(models)[1]?.rows).toHaveLength(2);
    const sessions = cyclePaletteGroup(models, 1);
    expect(selectedPaletteItem(sessions)?.value).toBe('s-1');
    expect(cyclePaletteGroup(sessions, -1).focus).toBe('models');
    // Wrapping: from the last group back to the first.
    const files = cyclePaletteGroup(sessions, 1);
    expect(cyclePaletteGroup(files, 1).focus).toBe('commands');
  });

  it('keeps the selected row when more rows arrive', () => {
    const state = movePalette(query('mod', COMMANDS), 1);
    expect(selectedPaletteItem(state)?.value).toBe('/model');
    const filled = setPaletteItems(state, ALL);
    expect(selectedPaletteItem(filled)?.value).toBe('/model');
  });
});

describe('palette render', () => {
  it('reads like the design at depth none', () => {
    expect(render(query('mod'))).toEqual([
      '┌─ ^P ─────────────────────────────────────────────────────────────────────────┐',
      '│ › mod                                                              5 results │',
      '├──────────────────────────────────────────────────────────────────────────────┤',
      '│ COMMANDS                                                                     │',
      '│▌ /mode    switch the input mode                                           ^G │',
      '│  /model   switch the model for this session                            alt+m │',
      "│  /models  browse every provider's catalogue                                  │",
      '│                                                                              │',
      '│ SESSIONS                                                                     │',
      '│    cart-fix · modify addItem                                          2m ago │',
      '│                                                                              │',
      '│ FILES                                                                        │',
      '│    src/models.js                                                    @ insert │',
      '└──────────────────────────────────────────────────────────────────────────────┘',
    ]);
  });

  it('marks the current model under the model columns', () => {
    const lines = render(query(''));
    expect(lines).toContain(
      '│ MODELS                                                     context  thinking │',
    );
    expect(lines).toContain(
      '│  ● anthropic/claude-sonnet-5-5  current                       200k  yes      │',
    );
  });

  it('says there is nothing to show', () => {
    expect(render(query('zzz'))).toEqual([
      '┌─ ^P ─────────────────────────────────────────────────────────────────────────┐',
      '│ › zzz                                                              0 results │',
      '├──────────────────────────────────────────────────────────────────────────────┤',
      '│  no matches — esc to close                                                   │',
      '└──────────────────────────────────────────────────────────────────────────────┘',
    ]);
  });

  it('paints the matched letters accent and the selected row raised', () => {
    const lines = renderPalette(rich, query('mod'), 80, {
      input: 'mod',
      maxRows: 30,
      keyLabel: '^P',
    });
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
    const selected = lines[4] ?? '';
    expect(selected).toContain(rich.open({ bg: 'bg3' }));
    expect(selected).toContain(rich.style({ fg: 'accent', bold: true })('mod'));
    expect(lines[5]).toContain(rich.fg('accent')('mod'));
    expect(lines[5]).not.toContain(rich.open({ bg: 'bg3' }));
  });

  it('keeps the selection in view when the list is taller than the room', () => {
    const files: PaletteItem[] = Array.from({ length: 30 }, (_, i) => ({
      group: 'files',
      value: `file-${i}.ts`,
      text: `file-${i}.ts`,
    }));
    const state = movePalette(cyclePaletteGroup(query('file', files), 1), -1);
    const lines = render(state, 60, 12);
    expect(lines).toHaveLength(12);
    expect(lines.join('\n')).toContain('▌   file-29.ts');
    expect(lines.at(-1)?.startsWith('└')).toBe(true);
  });

  it('opens a details footer with the whole row', () => {
    const lines = render(togglePaletteDetails(query('mod')), 40);
    expect(lines.at(-2)).toBe('│ /mode — switch the input mode        │');
    expect(lines.at(-3)?.startsWith('├')).toBe(true);
  });

  it('formats the model columns and ages', () => {
    expect(formatContextWindow(200_000)).toBe('200k');
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_048_576)).toBe('1M');
    expect(formatContextWindow(32_768)).toBe('33k');
    expect(paletteModelMeta(200_000, true)).toBe('   200k  yes     ');
    expect(paletteModelMeta(undefined, false)).toBe('         no      ');
    expect(formatAge(20_000)).toBe('just now');
    expect(formatAge(2 * 60_000)).toBe('2m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatAge(49 * 3_600_000)).toBe('2d ago');
  });
});
