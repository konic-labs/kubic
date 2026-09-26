// Slice A: journal diff core — attributed hunks from entries (issue #18; §42.2).
// RED: diffEntries/renderDiff do not exist yet.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import { type FileChange, diffEntries, renderDiff } from './journal-diff.js';

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

// Blob integrity (issue #111): corrupt journal content must surface as a
// named flag/marker, never crash the read path.
describe('corrupt journal content (issue #111)', () => {
  function tornDeltaStore(): {
    store: FileJournalStore;
    dir: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
    const store = new FileJournalStore(dir);
    const before = 'b\n'.repeat(40_000);
    const after = 'c\n'.repeat(40_000);
    const recorded = store.append({
      path: 'big.txt',
      op: 'write',
      before,
      after,
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    // Torn write: the delta blob survives only partially on disk.
    writeFileSync(join(dir, 'blobs', recorded.deltaHash ?? ''), '{torn');
    return { store, dir };
  }

  it('a torn delta blob marks the change corrupt instead of crashing diffEntries', () => {
    // Today this throws an uncaught SyntaxError out of applyDelta.
    const changes = diffEntries(tornDeltaStore().store, {});
    expect(changes).toHaveLength(1);
    expect(changes[0]?.corrupt).toBe(true);
  });

  it('renderDiff prints the corrupt-content marker for a corrupt change', () => {
    const change: FileChange = {
      path: 'big.txt',
      op: 'write',
      agentId: 'root',
      toolCallId: 'call-1',
      sessionId: 's1',
      timestamp: 100,
      unattributed: false,
      reversible: true,
      before: 'b\n',
      after: null,
      corrupt: true,
    };
    expect(renderDiff([change])).toContain('# [corrupt journal content]');
  });

  it('a healthy entry is not marked corrupt', () => {
    const changes = diffEntries(seed(), {});
    for (const c of changes) expect(c.corrupt).toBe(false);
    expect(renderDiff(changes)).not.toContain('# [corrupt journal content]');
  });
});
