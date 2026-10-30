// Alt-screen boot/stop lifecycle.
import { describe, expect, it } from 'vitest';
// The one shared fake Terminal.
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { buildLayoutRoot } from './layout.js';
import { bootScreen } from './screen.js';
import {
  CURSOR_MARKER,
  renderFakeCursor,
  Text,
  visibleWidth,
} from './tui-boundary.js';

describe('screen lifecycle', () => {
  it('boots the layout root and stops with restore', () => {
    const terminal = fakeTerminal(100);
    const root = buildLayoutRoot({
      tree: new Text('tree'),
      transcript: new Text('body'),
      status: new Text('status'),
      editor: new Text('editor'),
    });
    const count = (text: string, needle: string): number =>
      text.split(needle).length - 1;
    const screen = bootScreen(terminal, root);
    expect(terminal.started).toBe(1);
    // Boot enters the alt screen exactly once.
    expect(count(terminal.output(), '?1049h')).toBe(1);
    screen.render();
    const firstFrame = terminal.output().length;
    screen.render();
    // A forced render is synchronous, so no sleep is needed to read the frame
    // back off the alt screen: assert it structurally instead of
    // with a byte threshold — the buffer between the CSI 2026 markers carries
    // every content row getScreenLines() reports, one line per terminal row.
    const redraw = terminal.output().slice(firstFrame);
    const frameStart = redraw.lastIndexOf('?2026h');
    const frameEnd = redraw.indexOf('?2026l', frameStart);
    expect(frameStart).toBeGreaterThanOrEqual(0);
    expect(frameEnd).toBeGreaterThan(frameStart);
    const drawn = redraw.slice(frameStart, frameEnd);
    const lines = screen.tui.getScreenLines();
    expect(lines).toHaveLength(30);
    const contentRows = lines.filter((line) => visibleWidth(line) > 0);
    expect(contentRows.length).toBeGreaterThanOrEqual(4);
    for (const line of contentRows) expect(drawn).toContain(line);
    const output = terminal.output();
    expect(output).toContain('body');
    // CSI 2026 atomic frame per render.
    expect(output).toContain('?2026h');
    expect(output).toContain('?2026l');
    const printed: string[] = [];
    const beforeStop = terminal.output();
    screen.stop((line: string) => printed.push(line));
    expect(printed.join('\n')).toContain('body');
    // Stop leaves the alt screen (restore to main) exactly once.
    expect(count(terminal.output(), '?1049l')).toBe(1);
    expect(count(beforeStop, '?1049l')).toBe(0);
    // stop must unset the layout root before restoring the main screen —
    // otherwise TuiAltScreen.afterTerminalStop repaints the full layout
    // frame onto the main screen.
    const tail = terminal.output().slice(beforeStop.length);
    expect(tail).toContain('?1049l');
    expect(tail).not.toContain('body');
    expect(terminal.stopped).toBe(1);
    expect(terminal.started).toBe(1);
  });

  // The last-resort path (a signal or an exception) restores the
  // terminal without printing anything, and every stop is idempotent — a
  // crash that lands during a quit must never stop the terminal twice.
  it('restore leaves the alt screen without printing, and stop after restore is a no-op', () => {
    const terminal = fakeTerminal(100);
    const root = buildLayoutRoot({
      tree: new Text('tree'),
      transcript: new Text('body'),
      status: new Text('status'),
      editor: new Text('editor'),
    });
    const screen = bootScreen(terminal, root);
    screen.render();
    const beforeRestore = terminal.output().length;
    screen.restore();
    const tail = terminal.output().slice(beforeRestore);
    expect(tail).toContain('?1049l');
    expect(tail).toContain('?7h');
    expect(tail).not.toContain('body');
    const printed: string[] = [];
    screen.stop((line) => printed.push(line));
    screen.restore();
    expect(printed).toEqual([]);
    expect(terminal.stopped).toBe(1);
    expect(terminal.output().split('?1049l').length - 1).toBe(1);
  });

  // The final document lands on the MAIN screen. The
  // printer and the terminal share one ordered log: every document line is
  // printed after the alt screen is left (`?1049l`) and after autowrap is
  // back on (`?7h`) — never into the alternate buffer that `?1049l` discards.
  it('prints the final document after leaving the alt screen', () => {
    const log: string[] = [];
    const terminal = fakeTerminal(100);
    const write = terminal.write;
    terminal.write = (data: string) => {
      write(data);
      log.push(`TERM:${data}`);
    };
    const root = buildLayoutRoot({
      tree: new Text('tree'),
      transcript: new Text('the last answer'),
      status: new Text('status'),
      editor: new Text('editor'),
    });
    const screen = bootScreen(terminal, root);
    screen.render();
    screen.stop((line) => log.push(`OUT:${line}`));
    const exitAlt = log.findIndex(
      (entry) => entry.startsWith('TERM:') && entry.includes('?1049l'),
    );
    const autowrap = log.findIndex(
      (entry) => entry.startsWith('TERM:') && entry.includes('?7h'),
    );
    const firstLine = log.findIndex((entry) => entry.startsWith('OUT:'));
    expect(exitAlt).toBeGreaterThanOrEqual(0);
    expect(autowrap).toBeGreaterThanOrEqual(0);
    expect(firstLine).toBeGreaterThan(exitAlt);
    expect(firstLine).toBeGreaterThan(autowrap);
    // Nothing is written to the terminal after the document starts.
    expect(
      log.slice(firstLine).every((entry) => entry.startsWith('OUT:')),
    ).toBe(true);
    expect(
      log.filter((entry) => entry.startsWith('OUT:')).join('\n'),
    ).toContain('the last answer');
  });

  // The document printed on quit is the layout's own render, which still
  // carries the focused editor's hardware-cursor marker and the fake cursor:
  // the cell under the cursor between two zero-width APC markers, which Pi's
  // renderer turns into inverse video. Pi's stop path strips the hardware
  // marker before it prints; this path prints on the caller's channel, so it
  // must strip every marker — each is an APC sequence a plain terminal (or a
  // log) would show as garbage.
  describe('the final document carries no cursor artifacts', () => {
    const REVERSE = '\x1b[7m';
    const RESET = '\x1b[0m';
    const APC = '\x1b_';

    function printedFor(editorLine: string): string[] {
      const terminal = fakeTerminal(100);
      const root = buildLayoutRoot({
        tree: new Text('tree'),
        transcript: new Text('body'),
        status: new Text('status'),
        editor: new Text(editorLine),
      });
      const screen = bootScreen(terminal, root);
      screen.render();
      const printed: string[] = [];
      screen.stop((line) => printed.push(line));
      return printed;
    }

    it('strips the cursor marker and the fake cursor after it', () => {
      const printed = printedFor(
        `> hi${CURSOR_MARKER}${renderFakeCursor(' ')}`,
      ).join('\n');
      expect(printed).not.toContain(APC);
      expect(printed).toContain('> hi ');
    });

    it('keeps the character the fake cursor sat on', () => {
      const printed = printedFor(
        `ab${CURSOR_MARKER}${renderFakeCursor('c')}d`,
      ).join('\n');
      expect(printed).not.toContain(APC);
      expect(printed).toContain('abcd');
    });

    it('keeps a wide character and a combining sequence whole', () => {
      const printed = printedFor(
        `x${CURSOR_MARKER}${renderFakeCursor('日')} y${CURSOR_MARKER}${renderFakeCursor('e\u0301')}`,
      ).join('\n');
      expect(printed).toContain('x日 ye\u0301');
      expect(printed).not.toContain(APC);
    });

    it('strips a fake cursor that follows no hardware-cursor marker', () => {
      const printed = printedFor(`ab${renderFakeCursor('c')}d`).join('\n');
      expect(printed).not.toContain(APC);
      expect(printed).toContain('abcd');
    });

    it('leaves inverse-video text that is not the cursor untouched', () => {
      const printed = printedFor(
        `${REVERSE}selected${RESET} and ${CURSOR_MARKER}${renderFakeCursor(' ')}`,
      ).join('\n');
      expect(printed).toContain(`${REVERSE}selected${RESET}`);
      expect(printed).not.toContain(APC);
    });

    it('a line without a cursor is printed as rendered', () => {
      const printed = printedFor('plain editor line').join('\n');
      expect(printed).toContain('plain editor line');
    });
  });
});

// The base frame goes through a filter BEFORE the overlays are
// composited on it, so the palette's dimmed background never dims the
// palette itself.
describe('screen base filter', () => {
  it('filters the base frame, never an overlay on top of it', () => {
    const terminal = fakeTerminal(60);
    const root = buildLayoutRoot({
      tree: new Text('tree'),
      transcript: new Text('base row'),
      status: new Text('status'),
      editor: new Text('editor'),
    });
    const screen = bootScreen(terminal, root);
    screen.tui.baseFilter = (lines) =>
      lines.map((line) => line.replace('base', 'BASE'));
    screen.tui.showOverlay(new Text('overlay base'), {
      anchor: 'center',
      width: 20,
    });
    screen.render();
    const frame = screen.tui.getScreenLines().join('\n');
    expect(frame).toContain('BASE row');
    expect(frame).toContain('overlay base');
    screen.tui.baseFilter = undefined;
    screen.render();
    expect(screen.tui.getScreenLines().join('\n')).toContain('base row');
    screen.stop(() => {});
  });
});
