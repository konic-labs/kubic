// Slice B: alt-screen boot/stop lifecycle (issue #22; §16.1).
// RED: bootScreen does not exist yet.
import { describe, expect, it } from 'vitest';
import { buildLayoutRoot } from './layout.js';
import { bootScreen } from './screen.js';
import type { Terminal } from './tui-boundary.js';
import { Text } from './tui-boundary.js';

function fakeTerminal(width: number): Terminal & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    start: () => {},
    stop: () => {},
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
    const screen = bootScreen(terminal, root);
    screen.render();
    const output = terminal.writes.join('');
    expect(output).toContain('body');
    // CSI 2026 atomic frame per render (§16.1).
    expect(output).toContain('?2026h');
    expect(output).toContain('?2026l');
    const printed: string[] = [];
    screen.stop((line: string) => printed.push(line));
    expect(printed.join('\n')).toContain('body');
    // Stop leaves the alt screen (restore to main).
    expect(terminal.writes.join('')).toContain('?1049l');
  });
});
