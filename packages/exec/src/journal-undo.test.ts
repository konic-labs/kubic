// Slice B: undo core — reverse-chronological restore (issue #18; §42.2).
// RED: planUndo/applyUndo do not exist yet.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import { applyUndo, planUndo } from './journal-undo.js';

function seed(): { store: FileJournalStore; root: string } {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  writeFileSync(join(root, 'b.txt'), 'keep\n');
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 100,
  });
  writeFileSync(join(root, 'a.txt'), 'v2\n');
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v2\n',
    after: 'v3\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-2',
    timestamp: 200,
  });
  writeFileSync(join(root, 'a.txt'), 'v3\n');
  store.append({
    path: 'ghost.txt',
    op: 'write',
    before: null,
    beforeHash: 'abc',
    after: 'mystery\n',
    bytesDelta: 8,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: null,
    timestamp: 300,
    unattributed: true,
  });
  return { store, root };
}

describe('journal undo core (issue #18, slice B)', () => {
  it('plans whole-run undo reverse-chronologically with a summary', () => {
    const { store } = seed();
    const plan = planUndo(store, {});
    expect(plan.steps.map((s) => s.path)).toEqual([
      'ghost.txt',
      'a.txt',
      'a.txt',
    ]);
    expect(plan.reversible).toBe(2);
    expect(plan.nonReversible).toEqual(['ghost.txt']);
  });

  it('narrows by path and by single step, and dry-runs without touching disk', () => {
    const { store, root } = seed();
    const step = planUndo(store, { step: true });
    expect(step.steps.map((s) => s.path)).toEqual(['ghost.txt']);
    const path = planUndo(store, { path: 'a.txt' });
    expect(path.steps).toHaveLength(2);
    const before = planUndo(store, {});
    const result = applyUndo(store, before, root, { dryRun: true });
    expect(result.restored).toEqual(['a.txt', 'a.txt']);
    expect(result.skipped).toEqual(['ghost.txt']);
  });

  it('restores pre-run content and reports non-reversible instead of corrupting', () => {
    const { store, root } = seed();
    const scoped = planUndo(store, { path: 'a.txt' });
    const result = applyUndo(store, scoped, root, {});
    expect(result.restored).toEqual(['a.txt', 'a.txt']);
    expect(result.skipped).toEqual([]);
    const full = applyUndo(store, planUndo(store, {}), root, {});
    expect(full.restored).toEqual(['a.txt', 'a.txt']);
    expect(full.skipped).toEqual(['ghost.txt']);
  });
});
