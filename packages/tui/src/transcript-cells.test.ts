// Follow-end transcript fed by LaneSnapshot coarse cells.
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// ScrollView root directly (Component.render is pure) and assert document
// text plus follow/pinned offsets across batches.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { afterEach, describe, expect, it } from 'vitest';
import { createTuiTheme, setTuiTheme } from './theme.js';
import {
  createTranscriptView,
  formatPromptTime,
  renderReceipt,
} from './transcript.js';
import {
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from './tui-boundary.js';

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

const plainUi = createUiTheme(DARK_PALETTE, 'none');

describe('transcript op log and snapshot reuse', () => {
  const cells = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      kind: 'text' as const,
      markdown: `cell ${i}`,
    }));

  it('keeps no op log in production mode, and logs only when asked', () => {
    const view = createTranscriptView();
    const hundred = cells(100);
    for (let i = 0; i < 1000; i += 1) {
      view.applyLaneSnapshot({ laneId: 'l' }, hundred, i + 1);
    }
    // The TUI applies a snapshot on every lane event: a log holding a deep
    // copy of each one retains O(N·E) cells for no production reader.
    expect(view.writeLog).toHaveLength(0);
    // Replay and tests opt in explicitly.
    const logged = createTranscriptView({ ops: true });
    logged.applyLaneSnapshot({ laneId: 'l' }, hundred, 1);
    logged.appendDelta({ id: 'c0', kind: 'text', append: '!' });
    expect(logged.writeLog).toHaveLength(2);
  });

  it('reuses the unchanged cells of a re-applied snapshot', () => {
    const view = createTranscriptView();
    const first = [
      { id: 'a', kind: 'text' as const, markdown: 'one' },
      {
        id: 'b',
        kind: 'tool' as const,
        markdown: 'tool read',
        detail: 'x.ts',
        toolCallId: 'c1',
      },
    ];
    view.applyLaneSnapshot({ laneId: 'l' }, first, 1);
    const before = view.liveCells();
    view.applyLaneSnapshot({ laneId: 'l' }, first, 2);
    const same = view.liveCells();
    expect(same).toHaveLength(2);
    // Identity, not equality: the second apply allocates nothing for cells
    // whose content did not change.
    expect(same[0]).toBe(before[0]);
    expect(same[1]).toBe(before[1]);
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ ...first[0], markdown: 'one changed' }, first[1]],
      3,
    );
    const changed = view.liveCells();
    expect(changed[0]).not.toBe(before[0]);
    expect(changed[0]?.markdown).toBe('one changed');
    expect(changed[1]).toBe(before[1]);
  });
});

describe('compaction cells', () => {
  const SUMMARY_LINES = Array.from(
    { length: 12 },
    (_, i) => `summary line ${i}`,
  ).join('\n');

  function view(): ReturnType<typeof createTranscriptView> {
    const created = createTranscriptView();
    created.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'c1:compaction',
          kind: 'compaction',
          markdown: SUMMARY_LINES,
          detail: 'auto',
        },
      ],
      1,
    );
    return created;
  }

  it('shows a compaction marker cell and its summary, collapsed', () => {
    const doc = view().render(100).join('\n');
    // A fg2 rule names it (`── compacted · auto ──`).
    expect(doc).toMatch(/─+ compacted · auto ─+/);
    expect(doc).toContain('summary line 0');
    // Collapsed: the first rows plus the expand hint, like a tool card.
    expect(doc).not.toContain('summary line 11');
    expect(doc).toContain('^X expand');
  });

  it('expands the whole summary with Ctrl-X', () => {
    const created = view();
    created.toggleExpanded();
    const doc = created.render(100).join('\n');
    expect(doc).toContain('summary line 0');
    expect(doc).toContain('summary line 11');
    expect(doc).not.toContain('(ctrl+x to expand)');
  });

  it('keeps every row inside the width', () => {
    const created = view();
    for (const width of [40, 20]) {
      for (const line of created.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('streamed assistant draft', () => {
  it('renders the draft after the committed cells, before the commit', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'a0', kind: 'text', markdown: 'committed answer' }],
      1,
    );
    view.setStream('partial');
    const doc = view.render(80);
    const text = doc.join('\n');
    expect(text).toContain('partial');
    expect(doc.findIndex((line) => line.includes('partial'))).toBeGreaterThan(
      doc.findIndex((line) => line.includes('committed answer')),
    );
    // The commit replaces it: the draft is gone, the cell is not doubled.
    view.setStream(undefined);
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a0', kind: 'text', markdown: 'committed answer' },
        { id: 'a1', kind: 'text', markdown: 'partial' },
      ],
      2,
    );
    const after = view.render(80).join('\n');
    expect(after).not.toContain('partialpartial');
    expect(after.match(/partial/g)).toHaveLength(1);
  });

  it('sanitizes a streamed delta at ingress', () => {
    const ESC = String.fromCharCode(27);
    const view = createTranscriptView();
    view.setStream(`half${ESC}[2J\rvisible`);
    const doc = view.render(80);
    const text = doc.join('\n');
    expect(text).toContain('visible');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).not.toContain('[2J');
    for (const line of doc) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('wraps a long draft instead of cutting it', () => {
    const view = createTranscriptView();
    view.setStream('z'.repeat(300));
    const doc = view.render(80);
    expect(doc.join('').split('z').length - 1).toBe(300);
    for (const line of doc) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

describe('transcript blocks', () => {
  const at = new Date(2026, 9, 6, 14, 1, 52).getTime();

  it('draws the prompt block with its edge and time, prose with its mark', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'u',
          kind: 'prompt',
          markdown: '› run npm test and fix the failing test',
          timestamp: at,
        },
        { id: 't', kind: 'text', markdown: "I'll run the test suite first." },
      ],
      1,
    );
    const lines = view.render(80);
    expect(formatPromptTime(at)).toBe('14:01:52');
    const left = ' ▌ run npm test and fix the failing test';
    const right = 'you · 14:01:52 ';
    expect(lines[0]).toBe(
      `${left}${' '.repeat(80 - visibleWidth(left) - visibleWidth(right))}${right}`,
    );
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe("  ◆ I'll run the test suite first.");
  });

  it('wraps a long prompt under the edge and leaves the time off without one', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'u', kind: 'prompt', markdown: `› ${'word '.repeat(20)}end` }],
      1,
    );
    const lines = view.render(40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith(' ▌ ')).toBe(true);
    expect(lines.join('\n')).not.toContain('you ·');
  });

  it('paints the prompt block on bg2 at colour', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'u', kind: 'prompt', markdown: '› hi', timestamp: at }],
      1,
    );
    const line = view.render(60)[0] ?? '';
    expect(visibleWidth(line)).toBe(60);
    expect(line).toContain('\u001b[48;2;');
  });
});

describe('thinking and turn receipts', () => {
  const thought =
    'addItem overwrites qty instead of adding to it. The fix is a +=.';

  it('collapses thinking to its first sentence with the expand key', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'thinking', markdown: thought, durationMs: 4100 }],
      1,
    );
    const [line] = view.render(120);
    const left =
      '  ⋯ thought for 4.1s — addItem overwrites qty instead of adding to it.';
    expect(line).toBe(
      `${left}${' '.repeat(120 - visibleWidth(left) - 10)}^X expand `,
    );
    // Narrow: the key goes first, the sentence is cut.
    const [narrow] = view.render(60);
    expect(visibleWidth(narrow ?? '')).toBeLessThanOrEqual(60);
    expect(narrow).not.toContain('^X');
    // Expanded: every word, behind the gutter.
    view.toggleExpanded();
    const open = view.render(60);
    expect(open[0]).toBe('  ⋯ thought for 4.1s');
    expect(
      open
        .slice(1)
        .map((row) => row.slice(4))
        .join(' '),
    ).toContain('The fix is a +=.');
    for (const row of open.slice(1)) expect(row.startsWith('  │ ')).toBe(true);
  });

  it('says "thinking" when the time was not measured', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'thinking', markdown: 'Plan first' }],
      1,
    );
    expect(view.render(80)[0]).toContain('⋯ thinking — Plan first');
  });

  it('renders the receipt kinds', () => {
    const base = { elapsedMs: 18_400, tools: 4, costUsd: 0.031, diffKey: '^O' };
    const success = renderReceipt(
      plainUi,
      { outcome: 'completed', ...base, files: 1, added: 1, removed: 1 },
      100,
    );
    const left = '  ✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031';
    const right = '^O review diff   /undo revert ';
    expect(success).toBe(
      `${left}${' '.repeat(100 - visibleWidth(left) - visibleWidth(right))}${right}`,
    );
    expect(
      renderReceipt(plainUi, { outcome: 'completed', ...base, files: 0 }, 100),
    ).toBe('  ✓ turn 18.4s · 4 tools · $0.031');
    expect(
      renderReceipt(
        plainUi,
        { outcome: 'failed', ...base, files: 0, detail: 'provider exploded' },
        100,
      ),
    ).toBe('  ✕ turn failed · 18.4s · provider exploded');
    expect(
      renderReceipt(plainUi, { outcome: 'cancelled', ...base, files: 0 }, 100),
    ).toBe('  ○ turn cancelled · 18.4s');
    // Narrow: the right part drops first.
    const narrow = renderReceipt(
      plainUi,
      { outcome: 'completed', ...base, files: 1, added: 1, removed: 1 },
      60,
    );
    expect(narrow).toBe(left);
  });
});

describe('markdown on the tokens', () => {
  const answer = [
    '# Fixed',
    '',
    'Use `existing.qty += qty` in **src/cart.js:10**.',
    '',
    '- one',
    '- two',
    '',
    '```ts',
    'const total = 42;',
    '```',
    '',
    '> quoted',
  ].join('\n');

  const render = (width: number): string[] => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: answer }],
      1,
    );
    return view.render(width);
  };

  it('frames fenced code, bullets lists and pads inline code', () => {
    const doc = render(80).join('\n');
    expect(doc).toContain('  ◆ Fixed');
    expect(doc).toContain('Use  existing.qty += qty  in src/cart.js:10.');
    expect(doc).toContain('    • one');
    expect(doc).toContain('    ┌ ts');
    expect(doc).toContain('    │ const total = 42;');
    expect(doc).toContain('    └');
  });

  it('highlights fenced code at colour', async () => {
    const { loadHighlighter } = await import('./ui/highlight.js');
    await loadHighlighter();
    const theme = createTuiTheme('truecolor');
    setTuiTheme(theme);
    const doc = render(80).join('\n');
    expect(doc).toContain(theme.ui.fg('warn')('42'));
    expect(doc).toContain(
      theme.ui.style({ fg: 'fg0', bg: 'bg2' })(' existing.qty += qty '),
    );
  });
});

describe('a live theme switch', () => {
  it('repaints cached markdown in the new theme at the same depth', async () => {
    const { builtinThemePalette, createThemeFromPalette } = await import(
      './theme.js'
    );
    const transcript = createTranscriptView();
    transcript.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: 'Use `qty` here.' }],
      1,
    );
    const dark = createThemeFromPalette(
      builtinThemePalette('dark'),
      'truecolor',
      'dark',
    );
    const light = createThemeFromPalette(
      builtinThemePalette('light'),
      'truecolor',
      'light',
    );
    setTuiTheme(dark);
    const before = transcript.render(60).join('\n');
    expect(before).toContain(dark.ui.style({ fg: 'fg0', bg: 'bg2' })(' qty '));
    setTuiTheme(light);
    const after = transcript.render(60).join('\n');
    expect(after).toContain(light.ui.style({ fg: 'fg0', bg: 'bg2' })(' qty '));
    expect(after).not.toBe(before);
  });
});

describe('file links in answers', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  const view = () => {
    const transcript = createTranscriptView({
      fileUrl: (path) =>
        path === 'src/cart.js' ? 'file:///work/pg/src/cart.js' : undefined,
    });
    transcript.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: 'See src/cart.js:10 now.' }],
      1,
    );
    return transcript;
  };

  it('links project files where the terminal supports hyperlinks', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true });
    const lines = view().render(80);
    const line = lines.find((row) => row.includes('src/cart.js')) ?? '';
    expect(line).toContain('\u001b]8;;file:///work/pg/src/cart.js');
    // The link is zero width: the row reads exactly like the text.
    expect(visibleWidth(line)).toBe(
      visibleWidth('  ◆ See src/cart.js:10 now.'),
    );
  });

  it('leaves the text alone where it does not', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const doc = view().render(80).join('\n');
    expect(doc).toContain('See src/cart.js:10 now.');
    expect(doc).not.toContain('file://');
  });
});
