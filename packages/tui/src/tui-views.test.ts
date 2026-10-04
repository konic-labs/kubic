// The diff and journal panels (issue #96, acceptance criterion 3).
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
import { describe, expect, it } from 'vitest';
// One shared fake Terminal (issue #403): the panel's ScrollView is laid out
// only by the live alt-screen, so its scrolling is asserted on real frames.
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { bootScreen } from './screen.js';
import type { JournalChangeLike } from './tui-app.js';
import { createTuiApp } from './tui-app.js';
import { DiffPanel } from './view-panel.js';

const SESSION = 'sess-96';
const MODEL = 'test-model';
const ESC = '\u001b';
const BEL = '\u0007';

// Sent in BOTH encodings: the legacy control byte and the Kitty CSI-u form a
// protocol-negotiating terminal sends (issue #88's classification seam).
const OPEN_DIFF = '\u000f';
const OPEN_DIFF_KITTY = '\u001b[111;5u';
const OPEN_JOURNAL = '\u0012';
const OPEN_JOURNAL_KITTY = '\u001b[114;5u';

function change(overrides: Partial<JournalChangeLike> = {}): JournalChangeLike {
  return {
    path: 'src/app.ts',
    op: 'edit',
    agentId: 'root',
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
    mode: 'solo',
    approvalsSkipped: false,
  });
  app.applyLaneEvent({ type: 'run-start' });
  app.applyLaneEvent({
    type: 'tool-start',
    toolCallId,
    toolName: 'edit',
  });
  app.applyLaneEvent({
    type: 'tool-end',
    toolCallId,
    toolName: 'edit',
  });
  app.setJournalChanges(changes);
  return app;
}

describe('diff panel (issue #96, criterion 3)', () => {
  it('is not on screen before its key is pressed', () => {
    const app = appWithRun();
    const frame = app.render(100).join('\n');
    expect(frame).not.toContain('--- a/src/app.ts');
  });

  it('renders the current run changes on Ctrl-O (legacy byte)', () => {
    const app = appWithRun();
    const result = app.handleInput(OPEN_DIFF);
    expect(result.consumed).toBe(true);
    expect(result.quit).toBe(false);
    const frame = app.render(100).join('\n');
    // The diff view's own header (op label) plus the CLI-identical block.
    expect(frame).toContain('src/app.ts — edit');
    expect(frame).toContain('--- a/src/app.ts');
    expect(frame).toContain('+++ b/src/app.ts');
    // The unified hunks: the changed line is there in both directions. The
    // header is the real one the shared algorithm emits (context 3 clamped to
    // the two-line file: @@ -1,2 +1,2 @@).
    expect(frame).toContain('-const a = 1;');
    expect(frame).toContain('+const a = 2;');
    expect(frame).toContain('@@ -1,2 +1,2 @@');
  });

  it('toggles back off on Ctrl-O (Kitty CSI-u encoding)', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF_KITTY);
    expect(app.render(100).join('\n')).toContain('--- a/src/app.ts');
    const result = app.handleInput(OPEN_DIFF);
    expect(result.consumed).toBe(true);
    expect(app.render(100).join('\n')).not.toContain('--- a/src/app.ts');
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
    const frame = app.render(100).join('\n');
    expect(frame).toContain('--- a/src/app.ts');
    expect(frame).not.toContain('other/file.md');
    // Pinning the other call swaps the view to that call's effects.
    app.setDiffToolCall('tc-2');
    const swapped = app.render(100).join('\n');
    expect(swapped).toContain('other/file.md — write');
    expect(swapped).not.toContain('src/app.ts');
    // Releasing the pin hands the selection back to the run's own call.
    app.setDiffToolCall(null);
    expect(app.render(100).join('\n')).toContain('src/app.ts — edit');
  });

  it('says so plainly when the pinned call changed nothing', () => {
    const app = appWithRun([change({ toolCallId: 'tc-9' })]);
    app.setDiffToolCall('tc-none');
    app.handleInput(OPEN_DIFF);
    expect(app.render(100).join('\n')).toContain('no changes');
  });

  // Issue #311: following the run, a call that wrote nothing (a read, a
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

describe('diff panel multi-file and scrolling (issue #301)', () => {
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
    const doc = panel.lines(100).join('\n');
    expect(doc).toContain('--- a/src/app.ts');
    expect(doc).toContain('--- a/other/file.md');
    expect(doc).toContain('(file 1/2)');
    expect(doc).toContain('(file 2/2)');
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
    expect(screen.frame()).toContain('(file 1/2)');
    expect(screen.frame()).not.toContain('--- a/other/file.md');
    app.panelScrollTo(10_000);
    screen.render();
    expect(screen.frame()).toContain('--- a/other/file.md');
    expect(screen.frame()).toContain('(file 2/2)');
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
    expect(screen.frame()).toContain('-line 0');
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
    expect(screen.frame()).toContain('--- a/other/file.md');
    app.handleInput(ALT_UP);
    screen.render();
    expect(screen.frame()).toContain('--- a/big.txt');
    // Cycling wraps: from the first file, alt+up reaches the last one.
    app.handleInput(ALT_UP);
    screen.render();
    expect(screen.frame()).toContain('--- a/other/file.md');
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

  it('keeps the panel viewport where the operator left it on a repaint', () => {
    const app = appWithRun([longChange()]);
    app.handleInput(OPEN_DIFF);
    const screen = live(app);
    app.panelScrollTo(5);
    app.setJournalChanges([longChange(), change({ path: 'extra.txt' })]);
    expect(app.panelScrollTop()).toBe(5);
    screen.stop();
  });

  it('reopens the panel at its first file after a close (review #301)', () => {
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
    expect(screen.frame()).toContain('-line 0');
    screen.stop();
  });
});

describe('journal panel (issue #96, criterion 3)', () => {
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
    const frame = app.render(100).join('\n');
    expect(frame).toContain('--- a/src/app.ts');
    expect(frame).toContain('--- a/other/file.md');
  });

  it('opens on the Kitty CSI-u encoding and toggles off', () => {
    const app = appWithRun();
    expect(app.handleInput(OPEN_JOURNAL_KITTY).consumed).toBe(true);
    expect(app.render(100).join('\n')).toContain('--- a/src/app.ts');
    app.handleInput(OPEN_JOURNAL);
    expect(app.render(100).join('\n')).not.toContain('--- a/src/app.ts');
  });

  it('uses the filter journal-view.ts implements (path and agent)', () => {
    const app = appWithRun([
      change(),
      change({ path: 'other/file.md', op: 'write', agentId: 'worker-1' }),
    ]);
    app.handleInput(OPEN_JOURNAL);
    app.setJournalFilter({ path: 'other/file.md' });
    let frame = app.render(100).join('\n');
    expect(frame).toContain('--- a/other/file.md');
    expect(frame).not.toContain('--- a/src/app.ts');
    app.setJournalFilter({ agent: 'worker-1' });
    frame = app.render(100).join('\n');
    expect(frame).toContain('--- a/other/file.md');
    expect(frame).not.toContain('--- a/src/app.ts');
    app.setJournalFilter({});
    expect(app.render(100).join('\n')).toContain('--- a/src/app.ts');
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
    const frame = app.render(100).join('\n');
    // The journal body has no op-labelled header line (the CLI does not print
    // one), the diff view's first line does — so the header is the tell.
    expect(frame).toContain('--- a/src/app.ts');
    expect(frame).not.toContain('src/app.ts — edit');
    app.handleInput(OPEN_DIFF);
    expect(app.render(100).join('\n')).toContain('src/app.ts — edit');
  });
});

describe('panel content is untrusted (issue #96, criterion 3 sanitisation)', () => {
  it('strips control sequences from paths, attribution and file bodies', () => {
    // Both the row AND the run's own tool-call id carry controls (the id
    // comes back through the same lane event the tree reads), so this also
    // pins that the selection compares on the sanitized basis.
    const app = appWithRun(
      [
        change({
          path: `evil${ESC}[2Jname.ts`,
          agentId: `agent${BEL}x`,
          toolCallId: `tc${ESC}[31m`,
          before: `old${ESC}[2Jline\n`,
          after: `new${BEL}line\n`,
        }),
      ],
      `tc${ESC}[31m`,
    );
    app.handleInput(OPEN_DIFF);
    const frame = app.render(100).join('\n');
    // The readable words survive; no control byte from journal content does.
    expect(frame).toContain('evil');
    expect(frame).toContain('name.ts');
    expect(frame).toContain('agent');
    expect(frame).not.toContain('no changes');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
  });

  it('keeps the panel reachable on a narrow terminal where the tree hides', () => {
    const app = appWithRun();
    app.handleInput(OPEN_DIFF);
    const frame = app.render(70).join('\n');
    expect(frame).toContain('--- a/src/app.ts');
    // The tree itself is still hidden by the #22 rule.
    expect(frame).not.toMatch(/[✓●◌]/);
  });
});

describe('panel keys do not disturb the draft (issue #96, criterion 3)', () => {
  it('leaves plain d/D/j/J to the editor', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    for (const ch of 'dD jJ') app.handleInput(ch);
    expect(app.editor.getText()).toBe('dD jJ');
    expect(app.panelMode()).toBe('closed');
    expect(app.render(100).join('\n')).not.toContain('no changes');
  });
});
