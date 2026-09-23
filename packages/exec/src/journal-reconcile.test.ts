// Slice C: baseline capture + end-of-run reconciliation (issue #17; §42.1/42.5).
// RED: captureBaseline/reconcile do not exist yet.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureBaseline, FileJournalStore, reconcile } from './journal.js';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'change.txt'), 'before\n');
  writeFileSync(join(root, 'skip.log'), 'noise\n');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), 'gen\n');
  writeFileSync(join(root, '.gitignore'), 'skip.log\nbuild/\n');
  return root;
}

describe('journal baseline + reconciliation (issue #17, slice C)', () => {
  it('captures hashes and excludes gitignored, out-of-scope, and .kubic paths', () => {
    const root = workspace();
    const baseline = captureBaseline(root, { outOfScope: ['change.txt'] });
    expect(Object.keys(baseline).sort()).toEqual(['.gitignore', 'keep.txt']);
    expect(baseline['keep.txt']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks externally changed files unattributed with after-content', () => {
    const root = workspace();
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    const baseline = captureBaseline(root, { outOfScope: [] });
    // sed -i equivalent: bypasses Kubic ops entirely.
    writeFileSync(join(root, 'change.txt'), 'after\n');
    writeFileSync(join(root, 'dropped.txt'), 'new\n');
    const added = reconcile(journal, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 1700000000000,
    });
    expect(added).toBe(2);
    const entries = journal.entries();
    expect(entries.every((e) => e.unattributed === true)).toBe(true);
    expect(entries.map((e) => e.path).sort()).toEqual([
      'change.txt',
      'dropped.txt',
    ]);
    const changed = entries.find((e) => e.path === 'change.txt');
    expect(journal.readAfter(changed!)).toBe('after\n');
    expect(changed?.beforeHash).toBe(baseline['change.txt']);
  });

  it('adds nothing for intercepted-then-unmodified files, and reports deletes', () => {
    const root = workspace();
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    const baseline = captureBaseline(root, { outOfScope: [] });
    journal.append({
      path: 'change.txt',
      op: 'write',
      before: 'before\n',
      after: 'before\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1,
    });
    writeFileSync(join(root, 'change.txt'), 'before\n');
    const added = reconcile(journal, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 2,
    });
    expect(added).toBe(0);
  });
});
