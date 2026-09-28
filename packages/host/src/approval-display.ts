// What an approval dialog shows of a command (issue #316; §41.2, §16.4).
//
// The user decides on the request, so the display is built from the SAME
// args the approval key hashes — never from the model's description and
// never silently cut. A model can pad a harmless prefix past any character
// cap and hide a destructive tail; the defence is to carry the whole command
// to every seat and to mark every shortening with what it hid.
//
// The text is made safe to display, not reinterpreted: control characters
// (ESC, BEL, …) and the bidi / zero-width format characters that can reorder
// or hide what a terminal draws are shown as visible escapes (`\x1b`,
// `\u202e`); newlines and tabs are kept so a multi-line command reads as its
// lines; secret-shaped values are redacted like every other approval text.

import { redactSecrets } from '../../worker/src/lane/interceptors.js';

// The summary's command budget: summaries are one-line labels (trajectory,
// audit detail, the orchestrator's blocked indicator). The full command
// travels separately in the request's `command` field.
export const SUMMARY_COMMAND_LIMIT = 120;

const HIDDEN_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function visibleEscape(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x100
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

// The full command as a dialog shows it: redacted, every hidden character
// made visible, nothing cut.
export function approvalCommandText(command: string): string {
  return redactSecrets(command).replace(HIDDEN_CHARACTERS, visibleEscape);
}

// `<capability>: <command>` for summaries, shortened to `limit` characters
// with an explicit `… (+N chars)` marker — never a silent slice.
export function summarizeCommand(
  capability: string,
  command: string,
  limit: number = SUMMARY_COMMAND_LIMIT,
): string {
  const text = approvalCommandText(command);
  if (text.length <= limit) return `${capability}: ${text}`;
  return `${capability}: ${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}
