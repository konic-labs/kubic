// Content hashing for write/edit provenance.
// Pure string hashing — node:crypto only, no fs access, so this stays
// outside the I/O confinement rule (which covers fs/child_process).

import { createHash } from 'node:crypto';

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
