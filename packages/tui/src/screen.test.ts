// Slice B: alt-screen boot/stop lifecycle (issue #22; §16.1).
import { describe, expect, it } from 'vitest';
import { buildLayoutRoot } from './layout.js';
import { bootScreen } from './screen.js';
import type { Terminal } from './tui-boundary.js';
import { Text } from './tui-boundary.js';

function fakeTerminal(width: number): Terminal & {
  writes: string[];
  started: number;
  stopped: number;
} {
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  return {
    writes,
    get started(): number {
      return counts.started;
    },
    get stopped(): number {
      return counts.stopped;
    },
    start: () => {
      counts.started++;
    },
    stop: () => {
      counts.stopped++;
    },
    drainInput: () => Promise.resolve(),
    write: (data: string) => writes.push(data),
    get columns() {
      return width;
    },
    get rows() {
      return 30;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

describe('screen lifecycle (issue #22, slice B)', () => {
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
    expect(count(terminal.writes.join(''), '?1049h')).toBe(1);
    screen.render();
    const firstFrame = terminal.writes.join('').length;
    screen.render();
    // A full re-render draws the whole frame again (partial skips it).
    expect(terminal.writes.join('').length - firstFrame).toBeGreaterThan(500);
    const output = terminal.writes.join('');
    expect(output).toContain('body');
    // CSI 2026 atomic frame per render (§16.1).
    expect(output).toContain('?2026h');
    expect(output).toContain('?2026l');
    const printed: string[] = [];
    const beforeStop = terminal.writes.join('');
    screen.stop((line: string) => printed.push(line));
    expect(printed.join('\n')).toContain('body');
    // Stop leaves the alt screen (restore to main) exactly once.
    expect(count(terminal.writes.join(''), '?1049l')).toBe(1);
    expect(count(beforeStop, '?1049l')).toBe(0);
    // C3: stop must unset the layout root before restoring the main
    // screen — otherwise TuiAltScreen.afterTerminalStop repaints the
    // full layout frame onto the main screen (mutant: +1.4KB writes).
    const tail = terminal.writes.join('').slice(beforeStop.length);
    expect(tail).toContain('?1049l');
    expect(tail).not.toContain('body');
    expect(terminal.stopped).toBe(1);
    expect(terminal.started).toBe(1);
  });
});
