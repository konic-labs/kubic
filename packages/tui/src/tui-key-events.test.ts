// Kitty key-event types at the app's single input entry.
//
// pi-tui's ProcessTerminal negotiates Kitty flag 2 (report event types), so
// every key arrives as a press (no suffix, or ':1'), optional repeats (':2')
// and a release (':3'). Kubic's consuming listener routes raw data to
// TuiApp.handleInput before pi-tui's focused-path release filter, so the app
// must drop releases itself — otherwise every toggle cancels itself on
// key-up, a Ctrl-C cancel becomes a quit, and editor chords run twice.
import { describe, expect, it } from 'vitest';
import { createTuiApp, type TuiApp } from './tui-app.js';
import * as boundary from './tui-boundary.js';

const SESSION = 'key-events';
const MODEL = 'faux/m';

// Kitty CSI-u encodings: ctrl is modifier 5, no modifier is 1.
const press = (cp: number, mod = 5): string => `\x1b[${cp};${mod}u`;
const repeat = (cp: number, mod = 5): string => `\x1b[${cp};${mod}:2u`;
const release = (cp: number, mod = 5): string => `\x1b[${cp};${mod}:3u`;
const cp = (ch: string): number => ch.codePointAt(0) ?? 0;

const NOT_QUIT = { quit: false, consumed: true, cancel: false };

function app(): TuiApp {
  return createTuiApp({
    sessionId: SESSION,
    model: MODEL,
    approvalsSkipped: false,
  });
}

function type(target: TuiApp, text: string): void {
  for (const ch of text) target.handleInput(ch);
}

describe('key-release events are presses only once', () => {
  it('Ctrl-O press then release leaves the diff panel open', () => {
    const target = app();
    target.handleInput('\x1b[111;5u');
    target.handleInput('\x1b[111;5:3u');
    expect(target.panelMode()).toBe('diff');
  });

  it('the Ctrl-C release after a cancel press is neither a quit nor a cancel', () => {
    const target = app();
    target.setBusy(true);
    expect(target.handleInput(press(cp('c')))).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
    expect(target.handleInput(release(cp('c')))).toEqual(NOT_QUIT);
  });

  it('an idle Ctrl-C release never counts as the second press', () => {
    const target = app();
    // The press arms the double-press quit; its key-up must not complete it.
    expect(target.handleInput(press(cp('c')))).toEqual(NOT_QUIT);
    expect(target.handleInput(release(cp('c')))).toEqual(NOT_QUIT);
    expect(target.handleInput(press(cp('c')))).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
  });

  it('an Esc press denies a shown approval and its release does not quit', async () => {
    const target = app();
    const decision = target.requestApproval({
      key: 'bash:rm',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: 'rm -rf /tmp/x',
    });
    expect(target.handleInput('\x1b[27u')).toEqual(NOT_QUIT);
    expect(await decision).toMatchObject({ approved: false });
    expect(target.handleInput('\x1b[27;1:3u')).toEqual(NOT_QUIT);
  });

  const toggles: ReadonlyArray<
    readonly [string, string, (target: TuiApp) => unknown, unknown]
  > = [
    ['ctrl+o', 'o', (t) => t.panelMode(), 'diff'],
    ['ctrl+r', 'r', (t) => t.panelMode(), 'journal'],
    // The starts with the tree collapsed (hidden), so exactly
    // one toggle opens it.
    ['ctrl+t', 't', (t) => t.tree.isCollapsed(), false],
    ['ctrl+x', 'x', (t) => t.transcript.expanded, true],
  ];

  for (const [name, ch, read, toggled] of toggles) {
    it(`${name}: press then release toggles exactly once`, () => {
      const target = app();
      target.handleInput(press(cp(ch)));
      expect(target.handleInput(release(cp(ch)))).toEqual(NOT_QUIT);
      expect(read(target)).toEqual(toggled);
    });

    // Decision: a held toggle key does not strobe the panel — repeats of a
    // global key are dropped like releases (the editor keeps its repeats).
    it(`${name}: press, repeats, release still toggles exactly once`, () => {
      const target = app();
      target.handleInput(press(cp(ch)));
      target.handleInput(repeat(cp(ch)));
      target.handleInput(repeat(cp(ch)));
      target.handleInput(release(cp(ch)));
      expect(read(target)).toEqual(toggled);
    });
  }

  it('Ctrl-D press+release on a non-empty draft deletes exactly one character', () => {
    const target = app();
    type(target, 'abc');
    target.handleInput('\x1b[D');
    target.handleInput('\x1b[D');
    target.handleInput(press(cp('d')));
    expect(target.handleInput(release(cp('d')))).toEqual(NOT_QUIT);
    expect(target.editor.getText()).toBe('ac');
  });

  it('Ctrl-W press+release deletes exactly one word', () => {
    const target = app();
    type(target, 'one two three');
    target.handleInput(press(cp('w')));
    target.handleInput(release(cp('w')));
    expect(target.editor.getText()).toBe('one two ');
  });

  // Editor chords: the text after press+release equals the text after the
  // press alone (so the release never runs the chord a second time).
  const chords: ReadonlyArray<readonly [string, (target: TuiApp) => void]> = [
    [
      'k',
      (t) => {
        type(t, 'alpha beta');
        for (let i = 0; i < 4; i += 1) t.handleInput('\x1b[D');
      },
    ],
    [
      'u',
      (t) => {
        type(t, 'alpha beta');
      },
    ],
    [
      'y',
      (t) => {
        type(t, 'alpha beta');
        t.handleInput('\x17');
      },
    ],
    [
      'w',
      (t) => {
        type(t, 'alpha beta gamma');
      },
    ],
  ];

  for (const [ch, setup] of chords) {
    it(`ctrl+${ch}: the release does not run the chord again`, () => {
      const once = app();
      setup(once);
      once.handleInput(press(cp(ch)));
      const twice = app();
      setup(twice);
      twice.handleInput(press(cp(ch)));
      twice.handleInput(release(cp(ch)));
      expect(twice.editor.getText()).toBe(once.editor.getText());
    });
  }

  it('an editor key repeat still reaches the draft (held backspace)', () => {
    const target = app();
    type(target, 'abcd');
    target.handleInput(press(127, 1));
    target.handleInput(repeat(127, 1));
    target.handleInput(release(127, 1));
    expect(target.editor.getText()).toBe('ab');
  });

  it('legacy (non-Kitty) bytes are unaffected', () => {
    const target = app();
    expect(target.handleInput('\x0f')).toEqual(NOT_QUIT);
    expect(target.panelMode()).toBe('diff');
    expect(target.handleInput('\x03')).toEqual(NOT_QUIT);
    expect(target.handleInput('\x03')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
  });

  it('re-exports isKeyRelease and isKeyRepeat through the boundary', () => {
    expect(boundary.isKeyRelease(release(cp('c')))).toBe(true);
    expect(boundary.isKeyRelease(press(cp('c')))).toBe(false);
    expect(boundary.isKeyRepeat(repeat(cp('c')))).toBe(true);
  });
});
