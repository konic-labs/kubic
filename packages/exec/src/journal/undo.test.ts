// Undo core — reverse-chronological restore.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileJournalStore } from './store.js';
import { applyUndo } from './undo.js';
import { planUndo } from './undo-plan.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function seed(): { store: FileJournalStore; root: string } {
  const store = new FileJournalStore(tmpRoot('j-'));
  const root = tmpRoot('ws-');
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  writeFileSync(join(root, 'b.txt'), 'keep\n');
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
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
    toolCallId: null,
    timestamp: 300,
    unattributed: true,
  });
  return { store, root };
}

// Rewrites the index in the shape journals had before entries carried a
// source: an agent id in its place. Undo bookkeeping was recorded as
// `kubic-undo`; every other entry as the run's agent id. Lines already carrying
// a source are converted; lines already in the old shape are left alone.
function asLegacyIndex(dir: string): void {
  const indexPath = join(dir, 'index.jsonl');
  const lines = readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (!('source' in entry)) return line;
      const { source, ...rest } = entry;
      return JSON.stringify({
        ...rest,
        agentId: source === 'undo' ? 'kubic-undo' : 'root',
      });
    });
  writeFileSync(indexPath, `${lines.join('\n')}\n`);
}

// Undo must never overwrite a file whose current content no
// longer matches the entry's recorded afterHash — any change that landed
// after the journaled edit (manual edit, another run) would be silently
// destroyed. Stale steps skip with a named reason; --force overrides.
const ENTRY_BASE = {
  bytesDelta: 0,
  sessionId: 's1',
  toolCallId: 'call-1',
  timestamp: 100,
} as const;

function seedStale(): { store: FileJournalStore; root: string } {
  const store = new FileJournalStore(tmpRoot('j-'));
  const root = tmpRoot('ws-');
  return { store, root };
}

describe('a journal written before entries carried a source', () => {
  // Two tool writes to two files, the way main recorded them. The disk holds
  // the after-state, as it does when a run has just finished.
  function legacyTwoWrites(): { dir: string; root: string } {
    const dir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    const store = new FileJournalStore(dir);
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'a0\n',
      after: 'a1\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    store.append({
      path: 'b.txt',
      op: 'write',
      before: 'b0\n',
      after: 'b1\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-2',
      timestamp: 110,
    });
    asLegacyIndex(dir);
    return { dir, root };
  }

  it('maps each legacy line to its source on read, and drops the agent id', () => {
    const dir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    const store = new FileJournalStore(dir);
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'a0\n',
      after: 'a1\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    writeFileSync(join(root, 'c.txt'), 'c1\n');
    store.append({
      path: 'c.txt',
      op: 'write',
      before: null,
      after: 'c1\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 120,
      unattributed: true,
    });
    asLegacyIndex(dir);
    const reopened = new FileJournalStore(dir);
    expect(reopened.entries().map((e) => e.source)).toEqual(['tool', 'sweep']);
    expect(reopened.entries().some((e) => 'agentId' in e)).toBe(false);
  });

  it('plans and undoes the tool work as main does', () => {
    const { dir, root } = legacyTwoWrites();
    const store = new FileJournalStore(dir);
    const plan = planUndo(store, {});
    expect(plan.steps.map((s) => s.path).sort()).toEqual(['a.txt', 'b.txt']);
    const dry = applyUndo(store, plan, root, { dryRun: true });
    expect([...dry.restored].sort()).toEqual(['a.txt', 'b.txt']);
    const real = applyUndo(store, plan, root, {});
    expect([...real.restored].sort()).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a0\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b0\n');
  });

  it('dry-runs to nothing once an earlier undo restored the work', () => {
    const { dir, root } = legacyTwoWrites();
    applyUndo(
      new FileJournalStore(dir),
      planUndo(new FileJournalStore(dir), {}),
      root,
      {},
    );
    // The undo's records reach disk as main wrote them: `kubic-undo`.
    asLegacyIndex(dir);
    const store = new FileJournalStore(dir);
    const dry = applyUndo(store, planUndo(store, {}), root, { dryRun: true });
    expect(dry.restored).toEqual([]);
    expect(dry.skippedDetails.map((d) => d.path).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    for (const detail of dry.skippedDetails) {
      expect(detail.reason).toMatch(/^already undone/);
    }
  });

  it('does not recreate undone work once a prune has kept only the undo records', () => {
    const { dir, root } = legacyTwoWrites();
    applyUndo(
      new FileJournalStore(dir),
      planUndo(new FileJournalStore(dir), {}),
      root,
      {},
    );
    asLegacyIndex(dir);
    // A prune that keeps the newest records drops the old tool entries and
    // keeps the undo's own: the disk must stay where the user undid it.
    const indexPath = join(dir, 'index.jsonl');
    const kept = readFileSync(indexPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"agentId":"kubic-undo"'));
    writeFileSync(indexPath, `${kept.join('\n')}\n`);
    const store = new FileJournalStore(dir);
    const plan = planUndo(store, {});
    expect(plan.steps).toEqual([]);
    const real = applyUndo(store, plan, root, {});
    expect(real.restored).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a0\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b0\n');
  });
});

describe('journal undo core', () => {
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
    expect(path.steps.map((s) => [s.path, s.timestamp])).toEqual([
      ['a.txt', 200],
      ['a.txt', 100],
    ]);
    const before = planUndo(store, {});
    const entriesBefore = store.entries().length;
    const result = applyUndo(store, before, root, { dryRun: true });
    expect(result.restored).toEqual(['a.txt', 'a.txt']);
    expect(result.skipped).toEqual(['ghost.txt']);
    // A dry run is a pure simulation: no restore happens and —
    // no undo record is appended either.
    expect(store.entries()).toHaveLength(entriesBefore);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v3\n');
  });

  it('restores pre-run content, and each restore is itself journaled', () => {
    const { store, root } = seed();
    const scoped = planUndo(store, { path: 'a.txt' });
    const result = applyUndo(store, scoped, root, {});
    expect(result.restored).toEqual(['a.txt', 'a.txt']);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    // The undo is a change too. The journal's last two entries
    // are the undo records for the two steps the walk restored, attributed
    // to kubic-undo and carrying the pre-undo content as `before`.
    const tail = store.entries().slice(-2);
    expect(tail.map((e) => [e.sessionId, e.source, e.toolCallId])).toEqual([
      ['kubic-undo', 'undo', null],
      ['kubic-undo', 'undo', null],
    ]);
    expect(tail.map((e) => store.readBefore(e))).toEqual(['v3\n', 'v2\n']);
    expect(tail.map((e) => store.readAfter(e))).toEqual(['v2\n', 'v1\n']);
    // The plain walk still reads as idempotent (main's semantics): the
    // undo's own kubic-undo records are bookkeeping, not steps, so the
    // full re-planned undo reports the a.txt steps already-undone, writes
    // nothing and appends nothing.
    const full = applyUndo(store, planUndo(store, {}), root, {});
    expect(full.restored).toEqual([]);
    expect(full.skipped).toEqual(['ghost.txt', 'a.txt', 'a.txt']);
    expect(
      full.skippedDetails
        .filter((d) => d.path === 'a.txt')
        .every((d) => d.reason.startsWith('already undone:')),
    ).toBe(true);
    expect(store.entries()).toHaveLength(5); // 3 seed + the 2 undo records
  });

  it('reports already-undone instead of rewriting when disk sits at a journaled before-state', () => {
    const { store, root } = seed();
    // A re-planned walk contains the undo records (a second undo would redo
    // the first), so this pins the already-undone verdict through a
    // hand-built plan: the first a.txt
    // entry judged against a disk that already sits at its before-state.
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const [first] = store.entries();
    if (first === undefined) throw new Error('seed produced no entries');
    const result = applyUndo(
      store,
      {
        steps: [first],
        reversible: 1,
        nonReversible: [],
        stale: 0,
        stalePaths: [],
        // No marker in this store — nothing blocks the step.
        headMoves: [],
      },
      root,
      {},
    );
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['a.txt']);
    expect(result.skippedDetails[0]?.reason.startsWith('already undone:')).toBe(
      true,
    );
    // Nothing rewritten, and no undo record appended for a skip.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(store.entries()).toHaveLength(3);
  });
});

// A successful undo appends the inverse entry — before is the
// pre-undo content, after is the content just restored, attributed to
// `kubic-undo`. That makes the undo reviewable (`kubic diff`/`log` describe
// the world after it) and reversible: a second `undo --step` is the redo.
describe('undo record + redo', () => {
  function seedOne(): { store: FileJournalStore; root: string } {
    const store = new FileJournalStore(tmpRoot('j-'));
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1-longer\n',
      after: 'v2\n',
      ...ENTRY_BASE,
    });
    return { store, root };
  }

  it('journals the undo with pre-undo before, restored after, kubic-undo attribution', () => {
    const { store, root } = seedOne();
    const result = applyUndo(store, planUndo(store, { step: true }), root, {
      now: () => 4242,
    });
    expect(result.restored).toEqual(['a.txt']);
    const entries = store.entries();
    const record = entries[entries.length - 1];
    expect(record?.path).toBe('a.txt');
    expect(record?.op).toBe('write');
    expect(record?.sessionId).toBe('kubic-undo');
    expect(record?.source).toBe('undo');
    expect(record?.toolCallId).toBe(null);
    expect(record?.timestamp).toBe(4242);
    // Not an unattributed reconciliation find: it is attributed, to the undo.
    expect(record?.unattributed).toBe(undefined);
    expect(store.readBefore(record)).toBe('v2\n'); // pre-undo content
    expect(store.readAfter(record)).toBe('v1-longer\n'); // restored content
    expect(record?.bytesDelta).toBe(7); // 10 restored − 3 pre-undo
  });

  it('defaults the undo record timestamp to now when no clock is injected', () => {
    const { store, root } = seedOne();
    // Pin the wall clock (Date only) so the default is asserted exactly.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_234_567_890_123);
      applyUndo(store, planUndo(store, { step: true }), root, {});
    } finally {
      vi.useRealTimers();
    }
    const entries = store.entries();
    const record = entries[entries.length - 1];
    expect(record?.timestamp).toBe(1_234_567_890_123);
  });

  it('redo: a second undo --step immediately after restores the pre-undo content', () => {
    const { store, root } = seedOne();
    const undo = applyUndo(store, planUndo(store, { step: true }), root, {});
    expect(undo.restored).toEqual(['a.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1-longer\n');
    // The journal now ends with the undo record; undoing that record is the
    // redo — the same --step path, no special case.
    const redo = applyUndo(store, planUndo(store, { step: true }), root, {});
    expect(redo.restored).toEqual(['a.txt']);
    expect(redo.skipped).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('plain undo is idempotent: a second run restores nothing and appends nothing', () => {
    const { store, root } = seedOne();
    const first = applyUndo(store, planUndo(store, {}), root, {});
    expect(first.restored).toEqual(['a.txt']);
    expect(store.entries()).toHaveLength(2); // the agent write + its undo record
    // The plain plan must exclude the journal's own kubic-undo bookkeeping,
    // leaving the disk at the entry's before-state: already-undone, nothing
    // appended — the pre idempotent behavior.
    const second = applyUndo(store, planUndo(store, {}), root, {});
    expect(second.restored).toEqual([]);
    expect(second.skipped).toEqual(['a.txt']);
    expect(second.skippedDetails[0]?.reason.startsWith('already undone:')).toBe(
      true,
    );
    expect(store.entries()).toHaveLength(2);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1-longer\n');
    // The exclusion lives in the plan, so a dry-run reports the same skip and
    // appends nothing either.
    const dry = applyUndo(store, planUndo(store, {}), root, { dryRun: true });
    expect(dry.restored).toEqual([]);
    expect(dry.skipped).toEqual(['a.txt']);
    expect(store.entries()).toHaveLength(2);
  });

  it('plain undo skips interleaved bookkeeping; --step still targets the newest entry (the redo)', () => {
    const store = new FileJournalStore(tmpRoot('j-'));
    const root = tmpRoot('ws-');
    const undoRecord = (
      path: string,
      before: string,
      after: string,
      timestamp: number,
    ): void => {
      store.append({
        path,
        op: 'write',
        before,
        after,
        bytesDelta: 0,
        sessionId: 'kubic-undo',
        source: 'undo',
        toolCallId: null,
        timestamp,
      });
    };
    // A mixed log: real agent work interleaved with two kubic-undo records
    // (a.txt was undone once, b.txt is sitting undone right now).
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      ...ENTRY_BASE,
      timestamp: 100,
    });
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    undoRecord('a.txt', 'v2\n', 'v1\n', 200);
    writeFileSync(join(root, 'a.txt'), 'v3\n');
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v3\n',
      ...ENTRY_BASE,
      timestamp: 300,
    });
    writeFileSync(join(root, 'b.txt'), 'b2\n');
    store.append({
      path: 'b.txt',
      op: 'write',
      before: 'b1\n',
      after: 'b2\n',
      ...ENTRY_BASE,
      timestamp: 400,
    });
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    undoRecord('b.txt', 'b2\n', 'b1\n', 500);

    // Reverse-chronological agent work only: the bookkeeping records are
    // skipped over, not walked as steps.
    const plain = planUndo(store, {});
    expect(plain.steps.map((s) => [s.path, s.timestamp])).toEqual([
      ['b.txt', 400],
      ['a.txt', 300],
      ['a.txt', 100],
    ]);
    // --step keeps the redo: the newest entry is a kubic-undo record and
    // stays targetable.
    const step = planUndo(store, { step: true });
    expect(step.steps.map((s) => [s.path, s.source, s.timestamp])).toEqual([
      ['b.txt', 'undo', 500],
    ]);
    const result = applyUndo(store, plain, root, {});
    // The work still un-undone unwinds (a.txt v3→v1); the step an earlier
    // undo already unwound (b.txt) reads as already-undone. One append.
    expect(result.restored).toEqual(['a.txt']);
    expect(result.skipped).toEqual(['b.txt', 'a.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b1\n');
    expect(store.entries()).toHaveLength(6); // 5 seeded + 1 undo record
    // The record the walk just appended is the newest entry now, and --step
    // targets it — undoing it is the redo of the undo that just ran.
    expect(
      planUndo(store, { step: true }).steps.map((s) => [s.path, s.source]),
    ).toEqual([['a.txt', 'undo']]);
  });

  it('dry-run appends nothing; the real run appends exactly one record per restore', () => {
    const { store, root } = seedOne();
    const dry = applyUndo(store, planUndo(store, {}), root, { dryRun: true });
    expect(dry.restored).toEqual(['a.txt']);
    expect(store.entries()).toHaveLength(1);
    const real = applyUndo(store, planUndo(store, {}), root, {});
    expect(real.restored).toEqual(['a.txt']);
    expect(store.entries()).toHaveLength(2);
  });
});

describe('undo staleness safety', () => {
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
    const plan = planUndo(store, {}, root);
    expect(plan.stale).toBe(0);
    const result = applyUndo(store, plan, root, {});
    expect(result.restored).toEqual(['vanished.txt']);
    expect(result.skipped).toEqual([]);
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
    // Force changes the verdict, never the dry-run contract: disk untouched.
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
    expect(store.entries()).toHaveLength(1);
  });
});
