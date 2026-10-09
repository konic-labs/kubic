// Key routing for the interactive loop.
import { parseKey } from '@kubic/tui/tui-boundary';

export function keyIs(data: string, key: string): boolean {
  try {
    return parseKey(data) === key;
  } catch {
    return false;
  }
}

// How long an unterminated inline-image sequence is held before it is
// dropped with a footer: long enough for the
// chunks of one real paste (the pty delivers them back to back, and pi-tui's
// StdinBuffer flushes a partial OSC after 50 ms), short enough that a stray
// escape never swallows the operator's typing.
export const PASTE_IDLE_MS = 150;
