// One journal entry input with sensible defaults; a test overrides the
// fields it is about.
import type { JournalEntryInput } from '../journal/types.js';

export function entry(
  overrides: Partial<JournalEntryInput> = {},
): JournalEntryInput {
  return {
    path: 'src/a.ts',
    op: 'write',
    before: null,
    after: 'hello\n',
    bytesDelta: 6,
    sessionId: 's1',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
    ...overrides,
  };
}
