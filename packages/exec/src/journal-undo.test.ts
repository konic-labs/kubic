// Slice B: undo core — reverse-chronological restore (issue #18; §42.2).
// RED: planUndo/applyUndo do not exist yet.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileJournalStore, sha256Hex, sha256HexOfBytes } from './journal.js';
import { diffEntries } from './journal-diff.js';
import { journalStatus } from './journal-status.js';
import { applyUndo, planUndo } from './journal-undo.js';

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
    expect(path.steps.map((s) => [s.path, s.timestamp])).toEqual([
      ['a.txt', 200],
      ['a.txt', 100],
    ]);
    const before = planUndo(store, {});
    const entriesBefore = store.entries().length;
    const result = applyUndo(store, before, root, { dryRun: true });
    expect(result.restored).toEqual(['a.txt', 'a.txt']);
    expect(result.skipped).toEqual(['ghost.txt']);
    // A dry run is a pure simulation: no restore happens and — issue #117 —
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
    // Issue #117: the undo is a change too. The journal's last two entries
    // are the undo records for the two steps the walk restored, attributed
    // to kubic-undo and carrying the pre-undo content as `before`.
    const tail = store.entries().slice(-2);
    expect(tail.map((e) => [e.sessionId, e.agentId, e.toolCallId])).toEqual([
      ['kubic-undo', 'kubic-undo', null],
      ['kubic-undo', 'kubic-undo', null],
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
    // Issue #117 changed what a re-planned walk sees (the walk now contains
    // undo records, so a second undo redid the first), so this pins the
    // already-undone verdict through a hand-built plan: the first a.txt
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

// Issue #117: a successful undo appends the inverse entry — before is the
// pre-undo content, after is the content just restored, attributed to
// `kubic-undo`. That makes the undo reviewable (`kubic diff`/`log` describe
// the world after it) and reversible: a second `undo --step` is the redo.
describe('undo record + redo (issue #117)', () => {
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
    expect(record?.agentId).toBe('kubic-undo');
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
    // RED (issue #117 review fix): the plain plan walks the first undo's own
    // record too, so this run restores twice and appends two more records —
    // every repeat doubles the walk (an exponential append/fsync amplifier).
    // The plain plan must exclude the journal's own kubic-undo bookkeeping,
    // leaving the disk at the entry's before-state: already-undone, nothing
    // appended — the pre-#117 idempotent behavior.
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
        agentId: 'kubic-undo',
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
    expect(step.steps.map((s) => [s.path, s.agentId, s.timestamp])).toEqual([
      ['b.txt', 'kubic-undo', 500],
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
      planUndo(store, { step: true }).steps.map((s) => [s.path, s.agentId]),
    ).toEqual([['a.txt', 'kubic-undo']]);
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
  const store = new FileJournalStore(tmpRoot('j-'));
  const root = tmpRoot('ws-');
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

// §42.2 "kubic undo reverts the run": a file the agent CREATED has no
// pre-image by definition — its pre-state is "absent". Reverting the run
// removes it; reporting it non-reversible leaves the agent's new files
// behind after every undo.
describe('undo of an agent-created file', () => {
  function seedCreate(): { store: FileJournalStore; root: string } {
    const { store, root } = seedStale();
    writeFileSync(join(root, 'new.txt'), 'fresh\n');
    store.append({
      path: 'new.txt',
      op: 'create',
      before: null,
      after: 'fresh\n',
      ...ENTRY_BASE,
    });
    return { store, root };
  }

  it('plans the create as reversible and removes the file', () => {
    const { store, root } = seedCreate();
    const plan = planUndo(store, {}, root);
    expect(plan.reversible).toBe(1);
    expect(plan.nonReversible).toEqual([]);
    const result = applyUndo(store, plan, root, { now: () => 500 });
    expect(result.restored).toEqual(['new.txt']);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    // The removal is journaled as a delete whose before is the removed content.
    const last = store.entries().at(-1);
    expect(last?.op).toBe('delete');
    expect(last?.agentId).toBe('kubic-undo');
    expect(last?.afterHash).toBeNull();
    expect(last === undefined ? null : store.readBefore(last)).toBe('fresh\n');
  });

  it('redo (--step) brings the removed file back', () => {
    const { store, root } = seedCreate();
    applyUndo(store, planUndo(store, {}, root), root, {});
    const redo = applyUndo(
      store,
      planUndo(store, { step: true }, root),
      root,
      {},
    );
    expect(redo.restored).toEqual(['new.txt']);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('fresh\n');
  });

  it('a repeated plain undo reports already undone and appends nothing', () => {
    const { store, root } = seedCreate();
    applyUndo(store, planUndo(store, {}, root), root, {});
    const count = store.entries().length;
    const again = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(again.restored).toEqual([]);
    expect(again.skippedDetails[0]?.reason).toMatch(/already undone/);
    expect(store.entries()).toHaveLength(count);
  });

  it('refuses to remove a created file edited after the entry (stale), --force removes it', () => {
    const { store, root } = seedCreate();
    writeFileSync(join(root, 'new.txt'), 'user work\n');
    const plan = planUndo(store, {}, root);
    expect(plan.stalePaths).toEqual(['new.txt']);
    const result = applyUndo(store, plan, root, {});
    expect(result.restored).toEqual([]);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('user work\n');
    const forced = applyUndo(store, planUndo(store, {}, root), root, {
      force: true,
    });
    expect(forced.restored).toEqual(['new.txt']);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
  });

  it('dry-run reports the removal without touching disk', () => {
    const { store, root } = seedCreate();
    const dry = applyUndo(store, planUndo(store, {}, root), root, {
      dryRun: true,
    });
    expect(dry.restored).toEqual(['new.txt']);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('fresh\n');
    expect(store.entries()).toHaveLength(1);
  });

  it('unwinds create-then-edit in order, ending with the file removed', () => {
    const { store, root } = seedCreate();
    writeFileSync(join(root, 'new.txt'), 'edited\n');
    store.append({
      path: 'new.txt',
      op: 'edit',
      before: 'fresh\n',
      after: 'edited\n',
      ...ENTRY_BASE,
    });
    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(result.restored).toEqual(['new.txt', 'new.txt']);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
  });

  it('status and diff count the create as reversible', () => {
    const { store, root } = seedCreate();
    const status = journalStatus(store, root);
    expect(status.reversible).toBe(1);
    expect(status.nonReversible).toBe(0);
    expect(diffEntries(store, {})[0]?.reversible).toBe(true);
  });

  it('delete-then-create unwinds to the original file (a later create never masks an earlier delete)', () => {
    const { store, root } = seedStale();
    // foo existed; the agent removed it (journaled with content), then
    // wrote a new foo (a create).
    store.append({
      path: 'foo',
      op: 'delete',
      before: 'original\n',
      after: null,
      ...ENTRY_BASE,
    });
    writeFileSync(join(root, 'foo'), 'new\n');
    store.append({
      path: 'foo',
      op: 'create',
      before: null,
      after: 'new\n',
      ...ENTRY_BASE,
    });
    const plan = planUndo(store, {}, root);
    expect(plan.stalePaths).toEqual([]);
    const dry = applyUndo(store, plan, root, { dryRun: true });
    expect(dry.restored).toEqual(['foo', 'foo']);
    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(result.restored).toEqual(['foo', 'foo']);
    expect(readFileSync(join(root, 'foo'), 'utf8')).toBe('original\n');
  });

  it('warns when a forced removal cannot record the removed content (binary), so it cannot be redone', () => {
    const { store, root } = seedCreate();
    writeFileSync(join(root, 'new.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    const result = applyUndo(store, planUndo(store, {}, root), root, {
      force: true,
    });
    expect(result.restored).toEqual(['new.txt']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/new\.txt.*cannot be redone/);
  });

  it('keeps an unattributed reconciliation create non-reversible', () => {
    const { store, root } = seedStale();
    writeFileSync(join(root, 'built.js'), 'x\n');
    store.append({
      path: 'built.js',
      op: 'create',
      before: null,
      after: 'x\n',
      ...ENTRY_BASE,
      toolCallId: null,
      unattributed: true,
    });
    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(result.restored).toEqual([]);
    expect(existsSync(join(root, 'built.js'))).toBe(true);
  });
});

// Issue #348 review: the inverse record is appended AFTER the mutation, so a
// store whose bound cannot take that record must refuse the step BEFORE the
// file changes. Otherwise `kubic undo` restores a file, throws, and leaves
// the workspace changed with no undo/redo entry and no report of what
// happened — reachable even at the default bound, because the inverse record
// measures the pre-undo content whole plus the restored pre-image.
describe('undo refuses a step whose inverse record cannot fit (issue #348)', () => {
  it('leaves a restored file as it is when the record cannot fit', () => {
    const dir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    const before = 'a\n'.repeat(20_000); // 40 KB, stored whole
    const after = `${before}${'b\n'.repeat(30_000)}`; // 100 KB
    // The entry is the sweep's hash-only-after shape, so its own blobs are
    // just the 40 KB pre-image: it fits a bound its inverse record does not.
    const store = new FileJournalStore(dir, {
      maxBytes: 80_000,
      durable: false,
    });
    writeFileSync(join(root, 'big.txt'), after);
    store.append({
      path: 'big.txt',
      op: 'write',
      before,
      after: null,
      afterHash: sha256Hex(after),
      afterOmitted: true,
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 100,
    });

    // The dry run reports the same skip, so it never promises a restore the
    // real run refuses.
    const dry = applyUndo(store, planUndo(store, {}, root), root, {
      dryRun: true,
    });
    expect(dry.restored).toEqual([]);
    expect(dry.skipped).toEqual(['big.txt']);

    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    // The inverse record stores the 100 KB pre-undo content whole: over the
    // 80 KB bound, so the step is refused before the file is touched.
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['big.txt']);
    expect(result.skippedDetails[0]?.reason).toMatch(
      /too large to record: the inverse entry needs \d+ bytes, over the journal's 80000-byte bound/,
    );
    expect(result.warnings.join('\n')).toMatch(/big\.txt.*left as it is/);
    expect(readFileSync(join(root, 'big.txt'), 'utf8')).toBe(after);
    // Nothing was journaled either: the store still holds the one entry.
    expect(store.entries()).toHaveLength(1);
  });

  it('keeps a created file when its removal could not be recorded', () => {
    const dir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    const content = 'c\n'.repeat(50_000); // 100 KB
    const store = new FileJournalStore(dir, {
      maxBytes: 80_000,
      durable: false,
    });
    writeFileSync(join(root, 'created.txt'), content);
    store.append({
      path: 'created.txt',
      op: 'create',
      before: null,
      after: null,
      afterHash: sha256Hex(content),
      afterOmitted: true,
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 100,
    });

    const result = applyUndo(store, planUndo(store, {}, root), root, {});
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['created.txt']);
    expect(result.skippedDetails[0]?.reason).toMatch(/too large to record/);
    // A removal that could not be redone is never silent, and never happens.
    expect(existsSync(join(root, 'created.txt'))).toBe(true);
    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe(content);
    expect(store.entries()).toHaveLength(1);
  });
});

// Issue #352: the inverse record's before-side is a copy of the file as it is
// NOW (the pre-undo state). Reading it as utf-8 mangles binary bytes into
// U+FFFD, and a following `undo --step` (the redo) would write that mangled
// text back — corrupting the user's bytes. The create-removal path already
// applies the byte-exact lossless rule; the restore path must too.
describe('undo refuses to record a lossy pre-undo copy (issue #352)', () => {
  it('records the pre-undo state hash-only when it is not lossless utf-8', () => {
    const dir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    const store = new FileJournalStore(dir, { durable: false });
    writeFileSync(join(root, 'bin.dat'), 'v1\n');
    store.append({
      path: 'bin.dat',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    // The file has since become binary (invalid utf-8), and the entry is
    // restored with --force (the disk no longer matches the recorded state).
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    writeFileSync(join(root, 'bin.dat'), binary);

    const result = applyUndo(store, planUndo(store, {}), root, { force: true });
    expect(result.restored).toEqual(['bin.dat']);
    // The inverse record carries no mangled content: the raw hash, marked
    // as a designed omission — never U+FFFD text.
    const record = store.entries().at(-1);
    expect(record?.agentId).toBe('kubic-undo');
    expect(record?.beforeOmitted).toBe(true);
    expect(record?.beforeHash).toBe(sha256HexOfBytes(binary));
    // `bytesDelta` counts the bytes that were actually there: the 4-byte
    // binary pre-image against the 3-byte restored text (an omitted pre-image
    // is not "0 bytes before" — review of #352).
    expect(record?.bytesDelta).toBe(
      Buffer.byteLength('v1\n', 'utf8') - binary.length,
    );
    expect(record === undefined ? null : store.readBefore(record)).toBeNull();
    expect(result.warnings.join('\n')).toMatch(/bin\.dat.*cannot be redone/);

    // The forced restore landed the journaled pre-image...
    expect(readFileSync(join(root, 'bin.dat'), 'utf8')).toBe('v1\n');
    // ...and the redo refuses instead of writing mangled bytes back.
    const redo = applyUndo(store, planUndo(store, { step: true }), root, {});
    expect(redo.restored).toEqual([]);
    expect(redo.skippedDetails[0]?.reason).toMatch(/no before-content/);
    expect(readFileSync(join(root, 'bin.dat'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(root, 'bin.dat'), 'utf8')).not.toContain('\ufffd');
  });
});
