// Model and tool text made safe for the terminal: control sequences
// stripped, carriage-return redraws collapsed to what a terminal would show,
// and tabs expanded by column.

import { visibleWidth } from './tui-boundary.js';

// Lane text is untrusted terminal input:
// assistant text and tool output can contain ESC-prefixed control sequences
// ('\x1b[2J' clears the screen, '\x1b[31m' repaints colour, '\x1b[<n>A'
// moves the cursor over the status bar) and C0 controls like BEL. Passing
// them through verbatim lets a model or a tool drive the operator's
// terminal.
//
// The complete ECMA-48 sequences are stripped, not just the ESC
// byte. A tool that colours its output without a TTY (FORCE_COLOR test
// runners, git color.ui=always, npm progress bars) emits real escapes, and
// deleting only the ESC left the parameter bytes behind as visible noise
// ('[31mred'). Order matters: OSC first (it may contain ESC and '['), then
// CSI (7-bit and the 8-bit C1 form), then the general ESC form, then
// whatever control bytes are left. The renderer's own styling is untouched
// because only CONTENT is sanitized here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const C1_CSI_SEQUENCE = /\u009b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;
// \t, \n and \r are excluded: tabs expand, newlines split, and \r is
// collapsed (not deleted) by the pass below.
const CONTROL_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeLaneText(text: string): string {
  return expandTabs(collapseCarriageReturns(stripControlSequences(text)));
}

// A progress bar redraws its line with `\r`: a terminal shows what came
// after the last return, so that is what the transcript shows (deleting the
// returns instead would glue the frames together). This runs AFTER the
// sequence sweep and before tabs, so no return reaches a frame.
function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      // A trailing return moves the cursor without overwriting anything:
      // the text before it is what the terminal shows.
      const written = line.replace(/\r+$/, '');
      return written.split('\r').pop() ?? '';
    })
    .join('\n');
}

function stripControlSequences(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(C1_CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_SEQUENCES, '');
}

// Tabs are expanded to 8-column stops so width math and truncation count
// the columns a terminal would actually draw. The stop is measured with
// `visibleWidth`: a CJK glyph occupies two columns, so
// counting UTF-16 units misaligned every line after it.
/** @internal */
export const TAB_STOP = 8;

function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      // Measure only the run since the LAST tab. A grapheme
      // cannot span a tab, so the running column stays exact while the pass
      // is O(line) — calling `visibleWidth` on the whole accumulated line
      // per tab made a tab-heavy line (a generated table, a `printf` run)
      // quadratic on the untrusted ingress path.
      let column = 0;
      let pending = '';
      for (const ch of line) {
        if (ch === '\t') {
          const run = visibleWidth(pending);
          const pad = TAB_STOP - ((column + run) % TAB_STOP);
          out += `${pending}${' '.repeat(pad)}`;
          column += run + pad;
          pending = '';
        } else {
          pending += ch;
        }
      }
      return out + pending;
    })
    .join('\n');
}
