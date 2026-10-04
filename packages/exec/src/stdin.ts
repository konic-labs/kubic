// Stdin text (issue #258): `kubic eval --trajectory -` reads the
// trajectory JSON from stdin. The read is owned by exec (I/O confinement,
// §9) — the composition root never touches node:fs directly. Synchronous
// fd-0 read: the command is a one-shot CLI, so blocking until EOF is the
// documented behaviour (piping a file or a heredoc).
import { readFileSync } from 'node:fs';

export function readStdinText(): string {
  return readFileSync(0, 'utf8');
}
