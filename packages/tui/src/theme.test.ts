// The TUI theme's pure functions: colour-level detection for
// every documented environment branch, the elapsed-time formatter at its
// boundaries, and the spinner's wrap. Pure: no env is read or changed.
import { describe, expect, it } from 'vitest';
import { formatTurnClock } from './editor-frame.js';
import {
  createTuiTheme,
  detectColorLevel,
  setTuiTheme,
  spinnerFrame,
  tuiTheme,
} from './theme.js';

describe('detectColorLevel', () => {
  it.each([
    ['0', 'none'],
    ['false', 'none'],
    ['1', '16'],
    ['true', '16'],
    ['', '16'],
    ['2', '256'],
    ['3', 'truecolor'],
  ] as const)('FORCE_COLOR=%j → %s, even without a TTY', (force, level) => {
    expect(detectColorLevel({ FORCE_COLOR: force }, false)).toBe(level);
    expect(detectColorLevel({ FORCE_COLOR: force }, true)).toBe(level);
  });

  it('NO_COLOR (non-empty) beats FORCE_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }, true)).toBe(
      'none',
    );
  });

  it("NO_COLOR='' does not disable colour", () => {
    expect(
      detectColorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' }, true),
    ).toBe('truecolor');
  });

  it('a non-TTY gets no colour without FORCE_COLOR', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe('none');
  });

  it('TERM=dumb gets no colour', () => {
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe('none');
  });

  it('COLORTERM=truecolor and 24bit get truecolor (case-insensitive)', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(
      'truecolor',
    );
    expect(detectColorLevel({ COLORTERM: '24bit' }, true)).toBe('truecolor');
    expect(detectColorLevel({ COLORTERM: '24BIT' }, true)).toBe('truecolor');
  });

  it('TERM=*256color and TERM=xterm-direct get 256', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe('256');
    expect(detectColorLevel({ TERM: 'xterm-direct' }, true)).toBe('256');
  });

  it('anything else on a TTY gets the 16-colour set', () => {
    expect(detectColorLevel({ TERM: 'xterm' }, true)).toBe('16');
    expect(detectColorLevel({}, true)).toBe('16');
  });
});

describe('the turn clock and spinnerFrame', () => {
  it('formats the turn clock as m:ss and clamps negative time', () => {
    expect(formatTurnClock(0)).toBe('0:00');
    expect(formatTurnClock(59_999)).toBe('0:59');
    expect(formatTurnClock(60_000)).toBe('1:00');
    expect(formatTurnClock(61_500)).toBe('1:01');
    expect(formatTurnClock(-5)).toBe('0:00');
  });

  it('advances every 80 ms and wraps after the last frame', () => {
    const frames = Array.from({ length: 20 }, (_, i) => spinnerFrame(i * 80));
    expect(frames.indexOf(frames[0], 1)).toBe(10);
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(80));
    expect(spinnerFrame(79)).toBe(spinnerFrame(0));
    expect(spinnerFrame(800)).toBe(spinnerFrame(0));
    expect(spinnerFrame(-1)).toBe(spinnerFrame(0));
  });
});

describe('the active theme', () => {
  it('is none unless a test sets it — and the shared afterEach resets it', () => {
    expect(tuiTheme().level).toBe('none');
    setTuiTheme(createTuiTheme('truecolor'));
    expect(tuiTheme().level).toBe('truecolor');
    // Reset here: the shared setup's afterEach fails any test that leaves a
    // coloured theme behind.
    setTuiTheme(createTuiTheme('none'));
  });
});
