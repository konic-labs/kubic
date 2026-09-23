// Slice D: `kubic diff / undo / log / status` CLI (issue #18; §42.2, §78).
// RED: runJournalCommand does not exist yet.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

function setup(): {
  journalDir: string;
  root: string;
  out: { lines: string[]; write: (line: string) => void };
} {
  const journalDir = mkdtempSync(join(tmpdir(), 'j-'));
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  writeFileSync(join(root, 'a.txt'), 'v1\n');
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
  writeFileSync(join(root, 'a.txt'), 'v2\n');
  const lines: string[] = [];
  return {
    journalDir,
    root,
    out: { lines, write: (line) => lines.push(line) },
  };
}

describe('journal CLI (issue #18, slice D)', () => {
  it('diffs with attribution and filters, --json parses', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    expect(await runJournalCommand(['diff'], deps)).toBe(0);
    expect(out.lines.join('\n')).toContain('agent=root toolCall=call-1');
    const none: string[] = [];
    expect(
      await runJournalCommand(['diff', '--agent', 'nobody'], {
        ...deps,
        out: (l: string) => none.push(l),
      }),
    ).toBe(0);
    expect(none).toEqual(['no changes']);
    const json: string[] = [];
    expect(
      await runJournalCommand(['diff', '--json'], {
        ...deps,
        out: (l) => json.push(l),
      }),
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as Array<{ path: string }>;
    expect(parsed[0]?.path).toBe('a.txt');
  });

  it('undoes to pre-run content, dry-runs cleanly, and logs the timeline', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    const dry: string[] = [];
    expect(
      await runJournalCommand(['undo', '--dry-run'], {
        ...deps,
        out: (l) => dry.push(l),
      }),
    ).toBe(0);
    expect(dry.join('\n')).toContain('would restore');
    expect(await runJournalCommand(['undo'], deps)).toBe(0);
    const log: string[] = [];
    expect(
      await runJournalCommand(['log'], { ...deps, out: (l) => log.push(l) }),
    ).toBe(0);
    expect(log.join('\n')).toContain('a.txt');
    const status: string[] = [];
    expect(
      await runJournalCommand(['status'], {
        ...deps,
        out: (l) => status.push(l),
      }),
    ).toBe(0);
    expect(status.join('\n')).toContain('non-repo');
  });

  it('exits 2 on partial undo and 1 on bad usage', async () => {
    const { journalDir, root, out } = setup();
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'ghost.txt',
      op: 'write',
      before: null,
      after: 'm\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 2,
      unattributed: true,
    });
    const lines: string[] = [];
    const deps = { journalDir, root, out: (l: string) => lines.push(l) };
    expect(await runJournalCommand(['undo'], deps)).toBe(2);
    expect(lines.join('\n')).toContain('non-reversible');
    expect(await runJournalCommand(['frobnicate'], deps)).toBe(1);
    expect(await runJournalCommand(['diff', '--agent'], deps)).toBe(1);
    void out;
  });
});
