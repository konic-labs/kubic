// Slice A: journal diff core — attributed hunks from entries (issue #18; §42.2).
// RED: diffEntries/renderDiff do not exist yet.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import { diffEntries, renderDiff } from './journal-diff.js';

function seed(): FileJournalStore {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'one\ntwo\nthree\n',
    after: 'one\nTWO\nthree\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 100,
  });
  store.append({
    path: 'b.txt',
    op: 'create',
    before: null,
    after: 'new\n',
    bytesDelta: 4,
    sessionId: 's1',
    agentId: 'worker-1',
    toolCallId: 'call-2',
    timestamp: 200,
  });
  store.append({
    path: 'c.txt',
    op: 'write',
    before: null,
    beforeHash: 'deadbeef',
    after: 'mystery\n',
    bytesDelta: 8,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: null,
    timestamp: 300,
    unattributed: true,
  });
  return store;
}

describe('journal diff core (issue #18, slice A)', () => {
  it('lists every change with attribution and reversibility', () => {
    const changes = diffEntries(seed(), {});
    expect(changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(changes[0]).toMatchObject({
      agentId: 'root',
      toolCallId: 'call-1',
      reversible: true,
    });
    expect(changes[2]).toMatchObject({
      unattributed: true,
      toolCallId: null,
      reversible: false,
    });
  });

  it('filters by path and agent', () => {
    const store = seed();
    expect(diffEntries(store, { path: 'b.txt' }).map((c) => c.path)).toEqual([
      'b.txt',
    ]);
    expect(
      diffEntries(store, { agent: 'worker-1' }).map((c) => c.path),
    ).toEqual(['b.txt']);
  });

  it('renders attributed hunks, marking unattributed as such', () => {
    const text = renderDiff(diffEntries(seed(), {}));
    expect(text).toContain('--- a/a.txt');
    expect(text).toContain('+++ b/a.txt');
    expect(text).toContain('-two');
    expect(text).toContain('+TWO');
    expect(text).toContain('agent=root toolCall=call-1');
    expect(text).toContain('unattributed');
    // JSON form parses with jq semantics: array of change objects.
    const parsed = JSON.parse(JSON.stringify(diffEntries(seed(), {})));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].path).toBe('a.txt');
  });
});
