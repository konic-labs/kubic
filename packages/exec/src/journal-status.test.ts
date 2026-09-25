// Slice C: log timeline + status (issue #18; §42.2).
// RED: renderLog/journalStatus do not exist yet.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import {
  journalStatus,
  reconciliationSummary,
  renderLog,
} from './journal-status.js';

function seed(): FileJournalStore {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
  store.append({
    path: 'a.txt',
    op: 'edit',
    before: 'x\n',
    after: 'y\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
  });
  store.append({
    path: 'b.txt',
    op: 'write',
    before: null,
    beforeHash: 'abc',
    after: 'm\n',
    bytesDelta: 2,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: null,
    timestamp: 1700000001000,
    unattributed: true,
  });
  return store;
}

describe('journal log + status (issue #18, slice C)', () => {
  it('renders the timeline with timestamp/agent/toolCall/op/path/bytes', () => {
    const lines = renderLog(seed());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('edit');
    expect(lines[0]).toContain('a.txt');
    expect(lines[0]).toContain('root');
    expect(lines[0]).toContain('call-1');
    expect(lines[0]).toContain('2023-11-14T22:13:20.000Z');
    expect(lines[1]).toContain('reconciled');
  });

  it('reports non-repo status outside a repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const status = journalStatus(seed(), root);
    expect(status.entries).toBe(2);
    expect(status.reversible).toBe(1);
    expect(status.nonReversible).toBe(1);
    expect(status.repo).toBe(null);
  });

  it('reports branch state inside a repository without running naive git', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(
      join(root, '.git', 'HEAD'),
      'ref: refs/heads/feature/nested\n',
    );
    const status = journalStatus(seed(), root);
    expect(status.repo?.branch).toBe('feature/nested');
  });
});

describe('unattributed count (issue #87)', () => {
  it('counts reconciliation finds separately in status', () => {
    const status = journalStatus(seed(), mkdtempSync(join(tmpdir(), 'ws-')));
    expect(status.entries).toBe(2);
    expect(status.unattributed).toBe(1);
  });

  it('renders the count as a log summary line, keeping per-entry lines', () => {
    const lines = renderLog(seed());
    expect(lines).toHaveLength(2);
    expect(reconciliationSummary(seed())).toBe(
      'unattributed: 1 of 2 entr(ies) reconciled at run end',
    );
  });

  it('summarizes an empty journal without inventing entries', () => {
    const empty = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    expect(journalStatus(empty, mkdtempSync(join(tmpdir(), 'ws-')))).toEqual({
      entries: 0,
      reversible: 0,
      nonReversible: 0,
      unattributed: 0,
      repo: null,
    });
    expect(reconciliationSummary(empty)).toBe(
      'unattributed: 0 of 0 entr(ies) reconciled at run end',
    );
  });
});
