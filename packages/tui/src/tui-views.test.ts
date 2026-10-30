// The diff and journal panels.
//
// Headless snapshots only (there is no VirtualTerminal in the pinned
// pi-tui): every assertion below reads the pure render output of the app at
// a fixed width, the same pattern as layout.test.ts / tree.test.ts. Keys are
// sent through the app's own handleInput, which classifies them with pi-tui's
// `parseKey` (tui-boundary.ts) — both the legacy byte and the Kitty CSI-u
// encoding are exercised so a hand-parsed byte could not pass.
//
// The panel rows render at >= 100 columns on purpose: the top row is hidden
// below NARROW_COLUMNS, so a "the sequence is absent" assertion at a narrow
// width would be vacuous.

import type {
  KubicPresentationState,
  LaneSnapshot,
} from '@kubic/core/presentation';
import { describe, expect, it } from 'vitest';
// One shared fake Terminal: the panel's ScrollView is laid out
// only by the live alt-screen, so its scrolling is asserted on real frames.
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { panelBodyRows } from './app/panel.js';
import { PANEL_MAX_ROWS } from './layout.js';
import { bootScreen, stripCursor } from './screen.js';
import type { JournalChangeLike } from './tui-app.js';
import { createTuiApp } from './tui-app.js';
import { DiffPanel } from './view-panel.js';

// The app renders replicated state, so a test builds the state a
// projector would produce (the projector itself lives in host).
function presentation(
  over: Partial<LaneSnapshot> = {},
): KubicPresentationState {
  return {
    session: { sessionId: SESSION, approvalsSkipped: false },
    lane: {
      status: 'running',
      tools: [],
      queued: [],
      compacting: false,
      ...over,
    },
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

// The frame's words: the panels paint their rows, and the assertions read
// the text.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const words = (lines: readonly string[]): string =>
  lines.join('\n').replace(SGR, '');

const SESSION = 'sess-views';
const MODEL = 'test-model';
const ESC = '\u001b';
const BEL = '\u0007';

// Sent in BOTH encodings: the legacy control byte and the Kitty CSI-u form a
// protocol-negotiating terminal sends (the classification seam).
const OPEN_DIFF = '\u000f';
const OPEN_DIFF_KITTY = '\u001b[111;5u';
const OPEN_JOURNAL = '\u0012';
const OPEN_JOURNAL_KITTY = '\u001b[114;5u';

function change(overrides: Partial<JournalChangeLike> = {}): JournalChangeLike {
  return {
    path: 'src/app.ts',
    op: 'edit',
    toolCallId: 'tc-1',
    sessionId: SESSION,
    timestamp: 1,
    unattributed: false,
    reversible: true,
    before: 'const a = 1;\n',
    after: 'const a = 2;\n',
    ...overrides,
  };
}

// A tool call lands in the tree first (this is what "the current run's
// changes" hangs off), then its journal rows arrive.
function appWithRun(
  changes: ReadonlyArray<JournalChangeLike> = [change()],
  toolCallId = 'tc-1',
) {
  const app = createTuiApp({
    sessionId: SESSION,
    model: MODEL,
    approvalsSkipped: false,
  });
  // The lane is running with its edit call done: the state a projector would
  // hold after run-start/tool-start/tool-end.
  app.applyPresentation(
    presentation({
      status: 'running',
      tools: [
        {
          toolCallId,
          toolName: 'edit',
          status: 'done',
          isError: false,
        },
      ],
    }),
  );
  app.setJournalChanges(changes);
  return app;
}

describe('diff panel', () => {
  it('is not on screen before its key is pressed', () => {
    const app = appWithRun();
    const frame = words(app.render(100));
    expect(frame).not.toContain('src/app.ts  edit');
  });

  it('renders the current run changes on Ctrl-O (legacy byte)', () => {
    const app = appWithRun();
    const result = app.handleInput(OPEN_DIFF);
    expect(result.consumed).toBe(true);
    expect(result.quit).toBe(false);
    const frame = words(app.render(100));
    // The box's title, the file's header band (path, op, counts) and the
    // hunk's rows, numbered like the transcript's tool cards.
    expect(frame).toContain('Diff · last change');
    expect(frame).toContain('src/app.ts  edit');
    expect(frame).toContain('1 − const a = 1;');
    expect(frame).toContain('1 + const a = 2;');
  });

  it('toggles back off on Ctrl-O (Kitty CSI-u encoding)', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF_KITTY);
    expect(words(app.render(100))).toContain('src/app.ts  edit');
    const result = app.handleInput(OPEN_DIFF);
    expect(result.consumed).toBe(true);
    expect(words(app.render(100))).not.toContain('src/app.ts  edit');
  });

  it('shows only the selected tool call, not other calls in the journal', () => {
    const app = appWithRun([
      change(),
      change({
        path: 'other/file.md',
        op: 'write',
        toolCallId: 'tc-2',
        before: null,
        after: 'hello\n',
      }),
    ]);
    app.handleInput(OPEN_DIFF);
    const frame = words(app.render(100));
    expect(frame).toContain('src/app.ts  edit');
    expect(frame).not.toContain('other/file.md');
    // Pinning the other call swaps the view to that call's effects.
    app.setDiffToolCall('tc-2');
    const swapped = words(app.render(100));
    expect(swapped).toContain('other/file.md  write');
    expect(swapped).not.toContain('src/app.ts');
    // Releasing the pin hands the selection back to the run's own call.
    app.setDiffToolCall(null);
    expect(words(app.render(100))).toContain('src/app.ts  edit');
  });

  it('says so plainly when the pinned call changed nothing', () => {
    const app = appWithRun([change({ toolCallId: 'tc-9' })]);
    app.setDiffToolCall('tc-none');
    app.handleInput(OPEN_DIFF);
    expect(app.render(100).join('\n')).toContain('no changes');
  });

  // Following the run, a call that wrote nothing (a read, a
  // listing) must not blank the panel — it shows the most recent call that
  // has journal rows.
  it('follows the most recent call with journal rows when the run call wrote nothing', () => {
    const app = appWithRun([
      change({ path: 'old.md', toolCallId: 'tc-7', timestamp: 1 }),
      change({ path: 'new.md', toolCallId: 'tc-9', timestamp: 2 }),
    ]);
    app.handleInput(OPEN_DIFF);
    const frame = app.render(100).join('\n');
    expect(frame).toContain('new.md');
    expect(frame).not.toContain('old.md');
    expect(frame).not.toContain('no changes');
  });

  it('shows no changes while the session journal is empty', () => {
    const app = appWithRun([]);
    app.handleInput(OPEN_DIFF);
    expect(app.render(100).join('\n')).toContain('no changes');
  });
});

describe('diff panel multi-file and scrolling', () => {
  const ALT_UP = '\u001bp';
  const ALT_DOWN = '\u001bn';
  const ALT_DOWN_KITTY = '\u001b[1;3B';

  // Every line differs, so the hunk carries all 40 lines (a one-line edit
  // would produce a short hunk that already fits the panel).
  function longChange(): JournalChangeLike {
    const before = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const after = `${Array.from({ length: 40 }, (_, i) => `changed ${i}`).join('\n')}\n`;
    return change({ path: 'big.txt', before, after });
  }

  // The live alt-screen is the only place the panel's ScrollView is laid out
  // (the layout engine sizes and windows it there), so scrolling is asserted
  // on real frames — the same path the wheel uses.
  function live(app: ReturnType<typeof appWithRun>) {
    const terminal = fakeTerminal(100, 30);
    const screen = bootScreen(terminal, app.root);
    screen.render();
    return {
      frame: (): string => screen.tui.getScreenLines().join('\n'),
      render: (): void => screen.render(),
      stop: (): void => screen.stop(() => {}),
    };
  }

  it('renders every file of the selected call, with a file k/N header', () => {
    // Panel-level: the DOCUMENT carries every file (the frame windows it).
    const panel = new DiffPanel([
      change(),
      change({
        path: 'other/file.md',
        op: 'write',
        before: null,
        after: 'hello\n',
      }),
    ]);
    const doc = words(panel.lines(100));
    expect(doc).toContain('src/app.ts  edit');
    expect(doc).toContain('other/file.md  write');
    expect(doc).toContain('+1 −1  1/2');
    expect(doc).toContain('+0 −0  2/2');
  });

  it('reveals the second file by scrolling the panel', () => {
    const app = appWithRun([
      longChange(),
      change({
        path: 'other/file.md',
        op: 'write',
        before: null,
        after: 'hello\n',
      }),
    ]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    expect(screen.frame()).toContain('+40 −40  1/2');
    expect(screen.frame()).not.toContain('other/file.md');
    app.panelScrollTo(10_000);
    screen.render();
    expect(screen.frame()).toContain('other/file.md  write');
    expect(screen.frame()).toContain('+0 −0  2/2');
    screen.stop();
  });

  it('scrolls a 40-line diff to its last line through the panel scroll API', () => {
    const app = appWithRun([longChange()]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    expect(screen.frame()).not.toContain('changed 39');
    app.panelScrollTo(10_000);
    expect(app.panelScrollTop()).toBeGreaterThan(0);
    screen.render();
    expect(screen.frame()).toContain('changed 39');
    // Back to the top: the panel does not follow the end (no auto-scroll).
    app.panelScrollTo(0);
    expect(app.panelScrollTop()).toBe(0);
    screen.render();
    expect(screen.frame()).toContain('1 − line 0');
    screen.stop();
  });

  it('cycles files on alt+down / alt+up in both key encodings', () => {
    const app = appWithRun([
      longChange(),
      change({
        path: 'other/file.md',
        op: 'write',
        before: null,
        after: 'hello\n',
      }),
    ]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    expect(app.handleInput(ALT_DOWN_KITTY).consumed).toBe(true);
    screen.render();
    expect(screen.frame()).toContain('other/file.md  write');
    app.handleInput(ALT_UP);
    screen.render();
    expect(screen.frame()).toContain('big.txt  edit');
    // Cycling wraps: from the first file, alt+up reaches the last one.
    app.handleInput(ALT_UP);
    screen.render();
    expect(screen.frame()).toContain('other/file.md  write');
    screen.stop();
  });

  it('pages the journal panel with the same keys', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      change({
        path: `file-${String(i).padStart(2, '0')}.txt`,
        before: `old ${i}\n`,
        after: `new ${i}\n`,
      }),
    );
    const app = appWithRun(rows);
    app.handleInput(OPEN_JOURNAL);
    const screen = live(app);
    expect(screen.frame()).not.toContain('file-29.txt');
    for (let i = 0; i < 30; i += 1) app.handleInput(ALT_DOWN);
    screen.render();
    expect(screen.frame()).toContain('file-29.txt');
    screen.stop();
  });

  it('says where the viewport is in the closing rule once the body scrolls', () => {
    const app = appWithRun([longChange()]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    // 40 removed and 40 added rows under the file's header band.
    expect(screen.frame()).toMatch(/└─+ 1–\d+ of 81 ──┘/u);
    screen.stop();
  });

  it('keeps its rows when the transcript is long', () => {
    const app = appWithRun([longChange()]);
    app.appendNotice(Array.from({ length: 200 }, (_, i) => `note ${i}`));
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    const lines = screen.frame().split('\n');
    const top = lines.findIndex((line) => line.includes('Diff · last change'));
    const bottom = lines.findIndex(
      (line, index) => index > top && line.startsWith('└'),
    );
    // This screen has no overlay seat, so the terminal height is unknown and
    // the body takes the full cap.
    expect(bottom - top - 1).toBe(PANEL_MAX_ROWS);
    screen.stop();
  });

  it('keeps the panel viewport where the operator left it on a repaint', () => {
    const app = appWithRun([longChange()]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    app.panelScrollTo(5);
    app.setJournalChanges([longChange(), change({ path: 'extra.txt' })]);
    expect(app.panelScrollTop()).toBe(5);
    screen.stop();
  });

  it('reopens the panel at its first file after a close', () => {
    const app = appWithRun([longChange()]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    app.panelScrollTo(5);
    expect(app.panelScrollTop()).toBe(5);
    // The operator's real toggle path (Ctrl-O), not the API: the reset must
    // run there too, or a reopen would resume the old viewport.
    app.handleInput(OPEN_DIFF);
    expect(app.panelMode()).toBe('closed');
    app.handleInput(OPEN_DIFF);
    screen.render();
    expect(app.panelMode()).toBe('diff');
    expect(app.panelScrollTop()).toBe(0);
    expect(screen.frame()).toContain('1 − line 0');
    screen.stop();
  });
});

describe('journal panel', () => {
  it('renders the whole session journal on Ctrl-R (legacy byte)', () => {
    const app = appWithRun([
      change(),
      change({
        path: 'other/file.md',
        op: 'write',
        toolCallId: 'tc-2',
        before: null,
        after: 'hello\n',
      }),
    ]);
    const result = app.handleInput(OPEN_JOURNAL);
    expect(result.consumed).toBe(true);
    const frame = words(app.render(100));
    expect(frame).toContain('Journal · this session');
    expect(frame).toContain('src/app.ts  edit');
    expect(frame).toContain('other/file.md  write');
  });

  it('opens on the Kitty CSI-u encoding and toggles off', () => {
    const app = appWithRun();
    expect(app.handleInput(OPEN_JOURNAL_KITTY).consumed).toBe(true);
    expect(words(app.render(100))).toContain('Journal · this session');
    app.handleInput(OPEN_JOURNAL);
    expect(words(app.render(100))).not.toContain('Journal · this session');
  });

  it('uses the path filter journal-view.ts implements', () => {
    const app = appWithRun([
      change(),
      change({ path: 'other/file.md', op: 'write' }),
    ]);
    app.handleInput(OPEN_JOURNAL);
    app.setJournalFilter({ path: 'other/file.md' });
    const frame = words(app.render(100));
    expect(frame).toContain('other/file.md  write');
    expect(frame).not.toContain('src/app.ts');
    app.setJournalFilter({});
    expect(words(app.render(100))).toContain('src/app.ts  edit');
  });

  it('reports an empty journal instead of an empty frame', () => {
    const app = appWithRun([]);
    app.handleInput(OPEN_JOURNAL);
    expect(app.render(100).join('\n')).toContain('no changes');
  });

  it('the two panels are exclusive: opening one closes the other', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF);
    app.handleInput(OPEN_JOURNAL);
    const frame = words(app.render(100));
    // The title rule names the panel on screen.
    expect(frame).toContain('Journal · this session');
    expect(frame).not.toContain('Diff · last change');
    app.handleInput(OPEN_DIFF);
    expect(words(app.render(100))).toContain('Diff · last change');
  });
});

describe('the panel box', () => {
  it('names the panel and counts its files and lines in the title rule', () => {
    const app = appWithRun([change(), change({ path: 'b.ts' })]);
    app.handleInput(OPEN_JOURNAL);
    expect(words(app.render(100))).toMatch(
      /┌─ Journal · this session ─+ 2 files {2}\+2 −2 ──┐/u,
    );
  });

  it('closes on Esc, before Esc does anything else', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF);
    expect(app.handleInput(ESC).consumed).toBe(true);
    expect(app.panelMode()).toBe('closed');
    expect(words(app.render(100))).not.toContain('Diff · last change');
  });

  it('takes half the terminal less the rows around it, within the cap', () => {
    expect(panelBodyRows(undefined)).toBe(PANEL_MAX_ROWS);
    expect(panelBodyRows(80)).toBe(PANEL_MAX_ROWS);
    expect(panelBodyRows(30)).toBe(11);
    expect(panelBodyRows(12)).toBe(2);
    expect(panelBodyRows(4)).toBe(1);
  });
});

describe('panel content is untrusted', () => {
  it('strips control sequences from paths, tool-call ids and file bodies', () => {
    // Both the row AND the run's own tool-call id carry controls (the id
    // comes back through the same lane event the tree reads), so this also
    // pins that the selection compares on the sanitized basis.
    const app = appWithRun(
      [
        change({
          path: `evil${ESC}[2Jname.ts`,
          toolCallId: `tc${ESC}[31m`,
          before: `old${ESC}[2Jline\n`,
          after: `new${BEL}line\n`,
        }),
      ],
      `tc${ESC}[31m`,
    );
    app.handleInput(OPEN_DIFF);
    // Less the editor's own cursor markers, which Pi's renderer resolves.
    const frame = app.render(100).map(stripCursor).join('\n');
    // The readable words survive; no control byte from journal content does.
    expect(frame).toContain('evil');
    expect(frame).toContain('name.ts');
    expect(frame).not.toContain('no changes');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
  });

  it('keeps the panel reachable on a narrow terminal where the tree hides', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF);
    const frame = words(app.render(70));
    expect(frame).toContain('src/app.ts  edit');
    // The tree itself is still hidden by the rule (the status line's own
    // `●` mark is not a tree node).
    expect(frame).not.toMatch(/[✓●◌] default/);
  });
});

describe('panel keys do not disturb the draft', () => {
  it('leaves plain d/D/j/J to the editor', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    for (const ch of 'dD jJ') app.handleInput(ch);
    expect(app.editor.getText()).toBe('dD jJ');
    expect(app.panelMode()).toBe('closed');
    expect(app.render(100).join('\n')).not.toContain('no changes');
  });
});

describe('diff panel follows the run', () => {
  const tool = (toolCallId: string) => ({
    toolCallId,
    toolName: 'edit',
    status: 'done' as const,
    isError: false,
  });

  it('follows the newest tool call as the run progresses', () => {
    const app = appWithRun([
      change({ path: 'one.ts', toolCallId: 'tc-1' }),
      change({ path: 'two.ts', toolCallId: 'tc-2' }),
    ]);
    app.handleInput(OPEN_DIFF);
    expect(app.render(100).join('\n')).toContain('one.ts');
    // A second tool call lands while the panel is open: the panel follows the
    // run, so the newest call's effects are what it shows.
    app.applyPresentation(
      presentation({ status: 'running', tools: [tool('tc-1'), tool('tc-2')] }),
    );
    const frame = app.render(100).join('\n');
    expect(frame).toContain('two.ts');
    expect(frame).not.toContain('one.ts');
  });

  it('keeps an explicit pin across later tool events', () => {
    const app = appWithRun([
      change({ path: 'one.ts', toolCallId: 'tc-1' }),
      change({ path: 'two.ts', toolCallId: 'tc-2' }),
    ]);
    app.handleInput(OPEN_DIFF);
    app.setDiffToolCall('tc-1');
    expect(app.render(100).join('\n')).toContain('one.ts');
    // The run moves on; the pinned call is the operator's choice and wins.
    app.applyPresentation(
      presentation({
        status: 'running',
        tools: [tool('tc-1'), tool('tc-2'), tool('tc-3')],
      }),
    );
    expect(app.render(100).join('\n')).toContain('one.ts');
    // Releasing the pin hands the panel back to the run's newest call.
    app.setDiffToolCall(null);
    expect(app.render(100).join('\n')).toContain('two.ts');
  });
});
