// Journal CLI surfacing of the unattributed count (issue #87): `kubic status`
// names reconciliation finds on their own line, `kubic log` closes with the
// summary line. RED: neither exists today.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function seedUnattributed(): { journalDir: string; root: string } {
  const journalDir = mkTmp('j-');
  const root = mkTmp('ws-');
  const store = new FileJournalStore(journalDir);
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
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
    agentId: 'root',
    toolCallId: null,
    timestamp: 1700000001000,
    unattributed: true,
  });
  writeFileSync(join(root, 'b.txt'), 'v3\n');
  return { journalDir, root };
}

describe('journal CLI unattributed count (issue #87)', () => {
  it('status names the unattributed count on its own line', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = await runJournalCommand(['status'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('entries: 2 (reversible: 1, non-reversible: 1)');
    expect(text).toContain('unattributed: 1 of 2 (reconciled at run end)');
  });

  it('log closes the timeline with the unattributed summary', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = await runJournalCommand(['log'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      'unattributed: 1 of 2 entr(ies) reconciled at run end',
    );
    // The per-entry `reconciled` marker is unchanged.
    expect(lines[1]).toContain('reconciled');
  });

  it('log on an empty journal keeps its sentence and reports zero finds', async () => {
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
    const lines: string[] = [];
    const code = await runJournalCommand(['log'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      'journal is empty',
      'unattributed: 0 of 0 entr(ies) reconciled at run end',
    ]);
  });

  it('diff marks a sweep find unattributed and non-reversible', async () => {
    const { journalDir, root } = seedUnattributed();
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('b.txt');
    expect(text).toContain('[unattributed, non-reversible]');
  });
});
