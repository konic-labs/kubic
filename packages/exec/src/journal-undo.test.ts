// Slice B: undo core — reverse-chronological restore (issue #18; §42.2).
// RED: planUndo/applyUndo do not exist yet.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    // Issue #108 changed the second pass: undoing an already-undone walk no
    // longer silently re-writes (and mislabels) the same content — the
    // disk sits at a journaled before-state, so both a.txt steps are
    // reported already-undone and nothing is written.
    const full = applyUndo(store, planUndo(store, {}), root, {});
    expect(full.restored).toEqual([]);
    expect(full.skipped).toEqual(['ghost.txt', 'a.txt', 'a.txt']);
    expect(
      full.skippedDetails
        .filter((d) => d.path === 'a.txt')
        .every((d) => d.reason.startsWith('already undone:')),
    ).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });
});

// Issue #108: undo must never overwrite a file whose current content no
// longer matches the entry's recorded afterHash — any change that landed
// after the journaled edit (manual edit, another run) would be silently
// destroyed. Stale steps skip with a named reason; --force overrides.
const ENTRY_BASE = {
  bytesDelta: 0,
  sessionId: 's1',
  agentId: 'root',
  toolCallId: 'call-1',
  timestamp: 100,
} as const;

function seedStale(): { store: FileJournalStore; root: string } {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  return { store, root };
}

describe('undo staleness safety (issue #108)', () => {
  it('skips a write whose current content differs from the recorded after-state, disk untouched', () => {
    const { store, root } = seedStale();
    // Journaled v1→v2, then a manual edit landed v3 after the fact.
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['stale.txt']);
    expect(result.skippedDetails[0]?.reason ?? '').toMatch(/^stale:/);
    // The post-journal edit survives — that is the whole point.
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });

  it('restores the stale entry with force: true', () => {
    const { store, root } = seedStale();
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    const result = applyUndo(store, planUndo(store, {}), root, {
      force: true,
    });
    expect(result.restored).toEqual(['stale.txt']);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v1\n');
  });

  it('treats delete entries by the recreated-file rule: recreated is stale, still-missing restores', () => {
    const { store, root } = seedStale();
    // deleted then recreated after the journal recorded the delete → stale.
    writeFileSync(join(root, 'recreated.txt'), 'brand-new\n');
    store.append({
      path: 'recreated.txt',
      op: 'delete',
      before: 'old\n',
      after: null,
      ...ENTRY_BASE,
    });
    // deleted and still gone → restoring is safe (brings pre-delete back).
    store.append({
      path: 'still-gone.txt',
      op: 'delete',
      before: 'gone\n',
      after: null,
      ...ENTRY_BASE,
    });
    const result = applyUndo(store, planUndo(store, {}), root, {});
    expect(result.skipped).toEqual(['recreated.txt']);
    expect(result.skippedDetails[0]?.reason ?? '').toMatch(/^stale:/);
    expect(result.restored).toEqual(['still-gone.txt']);
    expect(readFileSync(join(root, 'still-gone.txt'), 'utf8')).toBe('gone\n');
    expect(readFileSync(join(root, 'recreated.txt'), 'utf8')).toBe(
      'brand-new\n',
    );
  });

  it('restores a vanished file (recreate path) without reporting stale', () => {
    const { store, root } = seedStale();
    // The write was journaled, then someone deleted the file. Restoring
    // recreates it — no data on disk is lost by the restore itself.
    store.append({
      path: 'vanished.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    const result = applyUndo(store, planUndo(store, {}), root, {});
    expect(result.restored).toEqual(['vanished.txt']);
    expect(readFileSync(join(root, 'vanished.txt'), 'utf8')).toBe('v1\n');
  });

  it('plans stale candidates read-only (planUndo never writes)', () => {
    const { store, root } = seedStale();
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    const plan = planUndo(store, {}, root);
    expect(plan.stale).toBe(1);
    expect(plan.stalePaths).toEqual(['stale.txt']);
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });

  it('dry-run classifies stale skips without writing, force overrides the plan', () => {
    const { store, root } = seedStale();
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    const dry = applyUndo(store, planUndo(store, {}), root, { dryRun: true });
    expect(dry.restored).toEqual([]);
    expect(dry.skipped).toEqual(['stale.txt']);
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
    const dryForced = applyUndo(store, planUndo(store, {}), root, {
      dryRun: true,
      force: true,
    });
    expect(dryForced.restored).toEqual(['stale.txt']);
    expect(dryForced.skipped).toEqual([]);
  });
});
