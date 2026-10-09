// Journal CLI surfacing of the unattributed count: `kubic status` names
// reconciliation finds on their own line, `kubic log` closes with the summary
// line.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileJournalStore } from '@kubic/exec/journal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runJournalCommand } from './journal-cli.js';

function seedUnattributed(): { journalDir: string; root: string } {
  const journalDir = tempDir('j-');
  const root = tempDir('ws-');
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
  // An end-of-run sweep find: hash only, no before-content.
  store.append({
    path: 'b.txt',
    op: 'write',
    before: null,
    beforeHash: 'deadbeef',
    after: 'v3\n',
    bytesDelta: 3,
    sessionId: 's1',
    toolCallId: null,
    timestamp: 1700000001000,
    unattributed: true,
  });
  writeFileSync(join(root, 'b.txt'), 'v3\n');
  return { journalDir, root };
}

describe('journal CLI unattributed count', () => {
  it('status names the unattributed count on its own line', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'status' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('entries: 2 (reversible: 1, non-reversible: 1)');
    expect(text).toContain('unattributed: 1 of 2 (reconciled at run end)');
  });

  it('log closes the timeline with the unattributed summary', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    // Header, two entry rows, the summary.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^TIME\s+TOOL CALL\s+OP\s+PATH\s+BYTES\s+NOTE$/);
    expect(lines[3]).toBe(
      'unattributed: 1 of 2 entr(ies) reconciled at run end',
    );
    // The per-entry `reconciled` marker sits in the NOTE column.
    expect(lines[1]).not.toContain('reconciled');
    expect(lines[2]).toMatch(/\sreconciled$/);
  });

  it('log names an unattributed row by its path, byte delta and note', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const row = lines.find((line) => line.includes('b.txt'));
    expect(row).toMatch(/\sb\.txt\s+\+3B\s+reconciled$/);
  });

  it('log on an empty journal keeps its sentence and reports zero finds', async () => {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines).toEqual([
      'journal is empty',
      'unattributed: 0 of 0 entr(ies) reconciled at run end',
    ]);
  });

  it('diff marks a sweep find unattributed and non-reversible', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('b.txt');
    expect(text).toContain('[unattributed, non-reversible]');
  });
});
