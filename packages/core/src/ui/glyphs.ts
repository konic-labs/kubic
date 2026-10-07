// Kubic glyphs (/README.md "Glyphs"). One glyph
// per meaning, used the same way in the TUI and the CLI.

/** Brand mark. */
export const BRAND = '■';
/** Focus edge: your prompt, the selected row or block. */
export const FOCUS_EDGE = '▌';
/** Assistant prose (fg1); waiting for you (warn). */
export const PROSE = '◆';
/** A tool call, coloured by its result. */
export const TOOL = '●';
/** Collapsed, queued or not set. */
export const COLLAPSED = '○';
/** Thinking, collapsed. */
export const THINKING = '⋯';
export const OK = '✓';
export const FAIL = '✕';
export const WARN = '▲';
export const INFO = 'ℹ';
/** Tool-card gutter and footer corner. */
export const GUTTER = '│';
export const CORNER = '└';
/** Light frame. */
export const FRAME_LIGHT = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
} as const;
/** Heavy frame (blocking cards). */
export const FRAME_HEAVY = {
  topLeft: '┏',
  topRight: '┓',
  bottomLeft: '┗',
  bottomRight: '┛',
  horizontal: '━',
  vertical: '┃',
  teeLeft: '┣',
  teeRight: '┫',
} as const;
/** Gauge cells and the run timeline. */
export const GAUGE = '━';
export const ELLIPSIS = '…';
export const MIDDOT = '·';
export const ARROW_UP = '↑';
export const ARROW_DOWN = '↓';
export const BRANCH = '⎇';
export const RETURN_KEY = '⏎';

/** Braille spinner frames for anything in flight. */
export const SPINNER_FRAMES: readonly string[] = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];

/** Milliseconds per spinner frame. */
export const SPINNER_INTERVAL_MS = 80;

export function spinnerFrame(elapsedMs: number): string {
  const index =
    Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) %
    SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0] ?? '';
}
