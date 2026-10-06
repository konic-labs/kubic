// OSC 52 copies (EPIC N, issue #463): the payload a terminal turns into a
// clipboard write, its tmux passthrough, and the size cap.
import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_MAX_BYTES,
  clipboardSupported,
  copySize,
  formatSize,
  osc52,
} from './clipboard.js';

const ESC = '\u001b';
const BEL = '\u0007';

describe('osc52 (issue #463)', () => {
  it('base64-encodes the text into the clipboard sequence', () => {
    expect(osc52('hello')).toBe(`${ESC}]52;c;aGVsbG8=${BEL}`);
  });

  it('encodes UTF-8, not UTF-16', () => {
    expect(osc52('çağ ✓')).toBe(
      `${ESC}]52;c;${Buffer.from('çağ ✓', 'utf8').toString('base64')}${BEL}`,
    );
  });

  it('wraps the sequence for tmux, doubling its escapes', () => {
    expect(osc52('hi', { tmux: true })).toBe(
      `${ESC}Ptmux;${ESC}${ESC}]52;c;aGk=${BEL}${ESC}\\`,
    );
  });

  it('measures what a copy takes, and caps it at 100 KB', () => {
    expect(copySize('çağ')).toBe(5);
    expect(CLIPBOARD_MAX_BYTES).toBe(100 * 1024);
  });

  it('refuses only a terminal known to drop the write', () => {
    expect(clipboardSupported({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(clipboardSupported({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(clipboardSupported({})).toBe(true);
  });

  it('names sizes the way the notice reads', () => {
    expect(formatSize(13)).toBe('13 B');
    expect(formatSize(1229)).toBe('1.2 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
