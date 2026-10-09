// The dimmed background behind the palette and the pickers ("the overlay floats
// over a dimmed screen; the background never moves"). Every base row loses its
// colours, links and markers and is drawn in fg3, so the overlay is the only
// thing in colour. The last row — the key hints — stays lit: it names the
// overlay's keys.

import type { UiTheme } from '@kubic/core/ui/style';

// Order matters: string sequences (OSC links, APC markers such as Pi's
// cursor marker, DCS/SOS/PM) may contain ESC and `[`, so they go first,
// then CSI, then any other two-byte escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
const STRING_SEQUENCE = /\u001b[\]_PX^][\s\S]*?(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;

/** One row without its styling, in fg3 (a blank row stays blank). */
export function dimLine(ui: UiTheme, line: string): string {
  const text = line
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '');
  return text.trim() === '' ? text : ui.fg('fg3')(text);
}

/** A whole frame dimmed, its last `keep` rows (the key hints) as they were. */
export function dimFrame(
  ui: UiTheme,
  lines: readonly string[],
  keep = 1,
): string[] {
  const cut = Math.max(0, lines.length - keep);
  return lines.map((line, index) => (index < cut ? dimLine(ui, line) : line));
}
