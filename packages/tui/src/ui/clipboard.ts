// OSC 52 copies (EPIC N, issue #463): the escape sequence a terminal turns
// into a system-clipboard write — the only clipboard a remote session (ssh,
// a container) reaches. Pure: the composition root writes the sequence to
// the terminal, and decides whether this terminal takes it.

/** Copies past this size are refused (a terminal may drop larger ones). */
export const CLIPBOARD_MAX_BYTES = 100 * 1024;

/** The bytes a copy of `text` takes (UTF-8). */
export function copySize(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * `ESC ] 52 ; c ; <base64> BEL`. Inside tmux the sequence rides tmux's
 * passthrough (`ESC P tmux; … ESC \`), its own escapes doubled.
 */
export function osc52(
  text: string,
  options: { readonly tmux?: boolean } = {},
): string {
  const sequence = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  if (options.tmux !== true) return sequence;
  return `\u001bPtmux;${sequence.replaceAll('\u001b', '\u001b\u001b')}\u001b\\`;
}

/** `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether this terminal takes OSC 52 writes. Only a terminal known to drop
 * them is refused (Apple's Terminal.app) — the operator is then told to view
 * and select instead of believing a copy happened.
 */
export function clipboardSupported(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.TERM_PROGRAM !== 'Apple_Terminal';
}
