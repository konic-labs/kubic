// A journal store, workspace and capture channels for the journal command
// tests.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileJournalStore } from '@kubic/exec/journal';
import { tempDir } from '../../../../test/temp-dir.js';

export function setup(): {
  journalDir: string;
  root: string;
  out: { lines: string[]; write: (line: string) => void };
} {
  const journalDir = tempDir('j-');
  const root = tempDir('ws-');
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  const store = new FileJournalStore(journalDir);
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
  });
  writeFileSync(join(root, 'a.txt'), 'v2\n');
  const lines: string[] = [];
  return {
    journalDir,
    root,
    out: { lines, write: (line) => lines.push(line) },
  };
}
