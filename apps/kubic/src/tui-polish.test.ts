// TUI polish: Konic palette, transcript tool blocks, streaming echo,
// working indicator, header, compact tree. Headless snapshots of pure
// render functions only (no terminal, no network).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHeader } from '../../../packages/tui/src/chrome.js';
import { renderWorkingLine } from '../../../packages/tui/src/editor-frame.js';
import { sanitizeLaneText } from '../../../packages/tui/src/lane-cells.js';
import {
  buildLayoutRoot,
  renderLayout,
  TREE_MAX_ROWS,
} from '../../../packages/tui/src/layout.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import {
  createTuiTheme,
  detectColorLevel,
  formatElapsed,
  setTuiTheme,
  spinnerFrame,
  tuiTheme,
} from '../../../packages/tui/src/theme.js';
import {
  createTranscriptView,
  TOOL_OUTPUT_PREVIEW_LINES,
} from '../../../packages/tui/src/transcript.js';
import {
  applyTreeSnapshot,
  createTreeState,
  renderTreeLines,
  type TreeToolSnapshot,
} from '../../../packages/tui/src/tree.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import { Text, visibleWidth } from '../../../packages/tui/src/tui-boundary.js';
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { TuiTurnRunner } from './tui-run.js';

const ESC = String.fromCharCode(27);
const plain = (line: string): string =>
  line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

describe('colour level detection', () => {
  it('honours NO_COLOR, FORCE_COLOR, TTY and TERM', () => {
    expect(
      detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true),
    ).toBe('none');
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe('none');
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(
      'truecolor',
    );
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm' }, true)).toBe('16');
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: '0' }, true)).toBe('none');
    expect(detectColorLevel({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
  });

  it('maps the Konic red onto every depth, identity when off', () => {
    expect(createTuiTheme('truecolor').accent('x')).toBe(
      `${ESC}[38;2;255;0;77mx${ESC}[39m`,
    );
    expect(createTuiTheme('256').accent('x')).toBe(
      `${ESC}[38;5;197mx${ESC}[39m`,
    );
    expect(createTuiTheme('16').accent('x')).toBe(`${ESC}[91mx${ESC}[39m`);
    expect(createTuiTheme('none').accent('x')).toBe('x');
  });

  it('animates the spinner and formats elapsed time', () => {
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(80));
    expect(formatElapsed(3_400)).toBe('3s');
    expect(formatElapsed(75_000)).toBe('1m 15s');
  });
});

function toolTranscript() {
  const view = createTranscriptView();
  const output = Array.from({ length: 9 }, (_, i) => `row ${i}`).join('\n');
  view.applyLaneSnapshot(
    { laneId: 'l' },
    [
      { id: 'u', kind: 'prompt', markdown: '› list files' },
      { id: 'a', kind: 'text', markdown: 'Looking **now**.' },
      {
        id: 'c1',
        kind: 'tool',
        markdown: 'tool bash',
        detail: 'ls',
        toolCallId: 'c1',
      },
      {
        id: 'c2',
        kind: 'tool',
        markdown: 'tool read',
        detail: 'x.ts',
        toolCallId: 'c2',
      },
      { id: 'r1', kind: 'output', markdown: output, toolCallId: 'c1' },
      {
        id: 'r2',
        kind: 'output',
        markdown: 'no such file',
        toolCallId: 'c2',
        isError: true,
      },
    ],
    1,
  );
  return view;
}

describe('transcript blocks', () => {
  it('renders prompt, prose, and each call with its output folded under it', () => {
    // Issue #455 (01-B…E): the prompt block's edge, the prose mark, and a
    // card per call with a gutter body and a footer naming what is hidden.
    expect(
      toolTranscript()
        .render(60)
        .map((line) => plain(line).trimEnd()),
    ).toEqual([
      ' ▌ list files',
      '',
      '  ◆ Looking now.',
      '',
      '  ● bash  ls',
      '  │ row 0',
      '  │ row 1',
      '  │ row 2',
      '  │ row 3',
      '  │ row 4',
      '  └ +4 lines   ^X expand',
      '',
      `  ● read  x.ts${' '.repeat(60 - 14 - 9)}✕ failed`,
      '  │ no such file',
    ]);
    expect(TOOL_OUTPUT_PREVIEW_LINES).toBe(5);
  });

  it('expands every output block on toggle', () => {
    const view = toolTranscript();
    expect(view.toggleExpanded()).toBe(true);
    const doc = view.render(60).join('\n');
    expect(doc).toContain('row 8');
    expect(doc).not.toContain('^X expand');
  });

  it('colours the call glyph by outcome under the Konic palette', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const lines = toolTranscript().render(60);
    const ok = lines.find((l) => plain(l).startsWith('  ● bash')) ?? '';
    const failed = lines.find((l) => plain(l).startsWith('  ● read')) ?? '';
    expect(ok).toContain('38;2;94;214;140m●');
    expect(failed).toContain('38;2;255;107;94m●');
    for (const line of lines)
      expect(plain(line).length).toBeLessThanOrEqual(60);
  });

  it('shows a running call with the accent spinner until its output lands', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'c', kind: 'tool', markdown: 'tool bash', toolCallId: 'c' }],
      1,
    );
    const head = view.render(40)[0] ?? '';
    expect(head).toContain('38;2;255;0;77m');
    expect(plain(head)).toContain('running');
  });

  it('truncates long lines to the width instead of wrapping tool output', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'c',
          kind: 'tool',
          markdown: 'tool bash',
          detail: 'x'.repeat(80),
          toolCallId: 'c',
        },
        { id: 'r', kind: 'output', markdown: 'y'.repeat(80), toolCallId: 'c' },
      ],
      1,
    );
    const lines = view.render(30);
    // Collapsed: both rows are CUT at the width (no wrap), and the output's
    // hint says so instead of pretending the row is complete (issue #300).
    expect(lines).toHaveLength(3);
    for (const line of lines)
      expect(plain(line).length).toBeLessThanOrEqual(30);
    expect(plain(lines[0] ?? '').endsWith('…')).toBe(true);
    expect(plain(lines[2] ?? '')).toContain('wide lines cut');
  });
});

describe('app chrome', () => {
  it('echoes a submitted prompt before the lane commits it', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    app.onSubmit(() => {});
    for (const ch of 'hello there') app.handleInput(ch);
    app.handleInput('\r');
    expect(app.transcript.render(80)).toContain(' ▌ hello there');
    app.applyLaneEntries([
      {
        id: 'u1',
        seq: 1,
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello there' }],
        },
      },
    ]);
    const doc = app.transcript.render(80).join('\n');
    expect(doc.split('▌ hello there')).toHaveLength(2);
  });

  it('shows the working indicator while busy and key hints when idle', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    expect(app.render(100).at(-1)).toContain('⏎ send');
    app.setBusy(true);
    expect(app.busyElapsedMs()).toBeGreaterThanOrEqual(0);
    // Issue #453/#454: the working line sits on the notice row above the
    // editor; the hint row switches to the keys that act on a running turn.
    const rows = app.render(100);
    expect(rows.join('\n')).toMatch(
      /Working · 0:0\d .*esc interrupt {3}⏎ queue a message/,
    );
    expect(rows.at(-1)).toContain('esc interrupt');
    expect(rows.at(-2)?.endsWith(' working ')).toBe(true);
    app.setBusy(false);
    expect(app.busyElapsedMs()).toBeUndefined();
  });

  it('names the queue key while a turn runs (#334)', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    app.setBusy(true);
    expect(app.render(100).join('\n')).toContain('⏎ queue a message');
  });

  it('toggles tool output expansion with Ctrl-X', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    expect(app.handleInput('\x18')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.transcript.expanded).toBe(true);
  });

  it('wraps a long footer onto a second row instead of cutting it', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    app.setEditorFooter(`solo: ${'word '.repeat(20)}end`);
    const rows = app.render(60);
    const at = rows.findIndex((row) => row.includes('solo:'));
    expect(at).toBeGreaterThan(0);
    expect(rows[at + 1]).toContain('end');
  });

  it('renders the header, hints and working line within the width', () => {
    const info = { approvalsSkipped: false } as const;
    expect(renderHeader(tuiTheme().ui, info, 60)).toBe(
      ` ■ KUBIC ${' '.repeat(60 - 9 - 13)}approvals on `,
    );
    expect(renderHeader(tuiTheme().ui, info, 20)).toBe(
      ` ■ KUBIC ${' '.repeat(11)}`,
    );
    const working = renderWorkingLine(tuiTheme().ui, { elapsedMs: 1500 }, 80);
    expect(visibleWidth(working)).toBe(80);
    expect(plain(working)).toContain('esc interrupt   ⏎ queue a message ');
  });
});

describe('compact tree', () => {
  it('folds older calls so the row never exceeds its cap', () => {
    const state = createTreeState();
    const tools: TreeToolSnapshot[] = [];
    for (let i = 0; i < 9; i += 1) {
      tools.push({
        toolCallId: `t${i}`,
        toolName: `tool${i}`,
        status: 'running',
        isError: false,
      });
    }
    applyTreeSnapshot(state, { status: 'running', tools });
    const lines = renderTreeLines(state, 80);
    expect(lines).toHaveLength(TREE_MAX_ROWS);
    expect(lines[1]).toBe('  … 5 earlier calls');
    expect(lines.at(-1)).toContain('tool8');
  });

  it('sizes the tree row to its content under a header', () => {
    const rows = renderLayout(
      buildLayoutRoot({
        header: new Text('head', 0, 0),
        tree: new Text('tree', 0, 0),
        transcript: new Text('body', 0, 0),
        status: new Text('status', 0, 0),
        editor: new Text('editor', 0, 0),
      }),
      100,
    ).map((row) => row.trim());
    expect(rows.filter((row) => row !== '')).toEqual([
      'head',
      'tree',
      'body',
      'editor',
      'status',
    ]);
  });
});

describe('review fixes', () => {
  const userEntry = (id: string, seq: number, text: string) => ({
    id,
    seq,
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

  it('keeps a resubmitted identical prompt echoed until the NEW cell lands', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    app.onSubmit(() => {});
    app.applyLaneEntries([userEntry('u1', 1, 'again')]);
    for (const ch of 'again') app.handleInput(ch);
    app.handleInput('\r');
    // A refresh that still only holds the OLD prompt must not clear the echo.
    app.applyLaneEntries([userEntry('u1', 1, 'again')]);
    expect(app.transcript.render(80).join('\n').split('▌ again')).toHaveLength(
      3,
    );
    app.applyLaneEntries([
      userEntry('u1', 1, 'again'),
      userEntry('u2', 2, 'again'),
    ]);
    expect(app.transcript.render(80).join('\n').split('▌ again')).toHaveLength(
      3,
    );
  });

  it('measures the header by visible width', () => {
    const line = renderHeader(
      tuiTheme().ui,
      { approvalsSkipped: false, project: 'kubic-playground' },
      60,
    );
    expect(visibleWidth(line)).toBe(60);
  });

  it('expands tabs to 8-column stops in lane text', () => {
    expect(sanitizeLaneText('a\tb')).toBe('a       b');
    expect(sanitizeLaneText('abcdefgh\tx\n\ty')).toBe(
      'abcdefgh        x\n        y',
    );
  });

  it('drops a transcript read that resolves after a newer one', async () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    // The durable entry the runner's read returns (pi.user carries the
    // message the app renders).
    const userRecord = (id: number, text: string) => ({
      id,
      conversationId: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: text }],
    });
    const resolvers: Array<(entries: unknown[]) => void> = [];
    const loop = {
      entries: () =>
        new Promise<unknown[]>((resolve) => {
          resolvers.push(resolve);
        }),
      context: {},
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[1];
    const runner = new TuiTurnRunner(app, loop, 'faux/m');
    const older = runner.refreshTranscript();
    const newer = runner.refreshTranscript();
    resolvers[1]?.([userRecord(2, 'fresh')]);
    await newer;
    resolvers[0]?.([userRecord(1, 'stale')]);
    await older;
    const doc = app.transcript.render(80).join('\n');
    expect(doc).toContain('▌ fresh');
    expect(doc).not.toContain('stale');
  });

  it('fully redraws on a width change even through the differential update', async () => {
    // Deterministic, no sleeps (issue #321): pi-tui schedules a requested
    // render with process.nextTick, then a setTimeout bounded by its render
    // interval, measured with performance.now(). Faking only the timer and the
    // clock lets the real nextTick fire, after which the pending render timer
    // is run directly — whatever the interval constant is.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const flush = async (): Promise<void> => {
      await new Promise<void>((resolve) => process.nextTick(resolve));
      vi.runOnlyPendingTimers();
    };
    const frameOf = (written: string): string => {
      const start = written.lastIndexOf(`${ESC}[?2026h`);
      const end = written.indexOf(`${ESC}[?2026l`, start);
      return start >= 0 && end > start ? written.slice(start, end) : '';
    };
    const terminal = fakeTerminal(80, 20);
    const body = new Text('body', 0, 0);
    const screen = bootScreen(
      terminal,
      buildLayoutRoot({
        tree: new Text('tree', 0, 0),
        transcript: body,
        status: new Text('status', 0, 0),
        editor: new Text('editor', 0, 0),
      }),
    );
    try {
      screen.render();
      // Same width, changed content: a differential frame IS written (so the
      // next assertion cannot pass on an empty write) and it never clears.
      body.setText('body, changed');
      let mark = terminal.writes.length;
      screen.update();
      await flush();
      const differential = frameOf(terminal.writes.slice(mark).join(''));
      expect(differential).toContain('changed');
      expect(differential).not.toContain(`${ESC}[2J`);
      // Width change: the update must write a full frame that clears first,
      // and the screen read back is laid out at the new width.
      terminal.setSize(60, 20);
      mark = terminal.writes.length;
      screen.update();
      await flush();
      const written = terminal.writes.slice(mark).join('');
      expect(frameOf(written)).not.toBe('');
      expect(written).toContain(`${ESC}[2J`);
      for (const line of screen.tui.getScreenLines())
        expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    } finally {
      screen.stop(() => {});
      vi.useRealTimers();
    }
  });
});
