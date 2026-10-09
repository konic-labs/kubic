// Undo core — reverse-chronological restore.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { diffEntries } from './diff.js';
import { sha256Hex, sha256HexOfBytes } from './hash.js';
import { journalStatus } from './status.js';
import { FileJournalStore } from './store.js';
import { applyUndo } from './undo.js';
import { planUndo } from './undo-plan.js';

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
  const store = new FileJournalStore(tempDir('j-'));
  const root = tempDir('ws-');
  return { store, root };
}

// "kubic undo reverts the run": a file the agent CREATED has no
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
    expect(last?.source).toBe('undo');
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

// The inverse record is appended AFTER the mutation, so a
// store whose bound cannot take that record must refuse the step BEFORE the
// file changes. Otherwise `kubic undo` restores a file, throws, and leaves
// the workspace changed with no undo/redo entry and no report of what
// happened — reachable even at the default bound, because the inverse record
// measures the pre-undo content whole plus the restored pre-image.
describe('undo refuses a step whose inverse record cannot fit', () => {
  it('leaves a restored file as it is when the record cannot fit', () => {
    const dir = tempDir('j-');
    const root = tempDir('ws-');
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
    const dir = tempDir('j-');
    const root = tempDir('ws-');
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

// The inverse record's before-side is a copy of the file as it is
// NOW (the pre-undo state). Reading it as utf-8 mangles binary bytes into
// U+FFFD, and a following `undo --step` (the redo) would write that mangled
// text back — corrupting the user's bytes. The create-removal path already
// applies the byte-exact lossless rule; the restore path must too.
describe('undo refuses to record a lossy pre-undo copy', () => {
  it('records the pre-undo state hash-only when it is not lossless utf-8', () => {
    const dir = tempDir('j-');
    const root = tempDir('ws-');
    const store = new FileJournalStore(dir, { durable: false });
    writeFileSync(join(root, 'bin.dat'), 'v1\n');
    store.append({
      path: 'bin.dat',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    // The file has since become binary (invalid utf-8), and the entry is
    // restored with --force (the disk does not match the recorded state).
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    writeFileSync(join(root, 'bin.dat'), binary);

    const result = applyUndo(store, planUndo(store, {}), root, { force: true });
    expect(result.restored).toEqual(['bin.dat']);
    // The inverse record carries no mangled content: the raw hash, marked
    // as a designed omission — never U+FFFD text.
    const record = store.entries().at(-1);
    expect(record?.source).toBe('undo');
    expect(record?.beforeOmitted).toBe(true);
    expect(record?.beforeHash).toBe(sha256HexOfBytes(binary));
    // `bytesDelta` counts the bytes that were actually there: the 4-byte
    // binary pre-image against the 3-byte restored text (an omitted pre-image
    // is not "0 bytes before").
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

describe('HEAD-move barrier', () => {
  const MOVE_A = { head: 'a'.repeat(40), branch: 'main', stash: 0 };
  const MOVE_B = { head: 'b'.repeat(40), branch: 'feature', stash: 0 };

  function roots2(): { root: string; store: FileJournalStore } {
    const root = tempDir('ws-head-undo-');
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const store = new FileJournalStore(tempDir('j-head-undo-'));
    // An entry older than the move: restoring it crosses the marker.
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 't1',
      timestamp: 1,
    });
    store.append({
      path: '',
      op: 'marker',
      before: null,
      after: null,
      bytesDelta: 0,
      headFrom: MOVE_A,
      headTo: MOVE_B,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 2,
      unattributed: true,
    });
    return { root, store };
  }

  it('refuses to cross the marker without --force and names the move', () => {
    const { root, store } = roots2();
    const plan = planUndo(store, {}, root);
    expect(plan.steps.map((s) => s.path)).toEqual(['a.txt']);
    expect(plan.headMoves).toEqual([{ from: MOVE_A, to: MOVE_B }]);
    const result = applyUndo(store, plan, root, {});
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual(['a.txt']);
    expect(result.skippedDetails[0]?.reason).toMatch(/^head-moved: /);
    expect(result.skippedDetails[0]?.reason).toContain('feature@');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('proceeds across the marker with --force', () => {
    const { root, store } = roots2();
    const result = applyUndo(store, planUndo(store, {}, root), root, {
      force: true,
    });
    expect(result.restored).toEqual(['a.txt']);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  it('lets entries newer than the marker through without --force', () => {
    const { root, store } = roots2();
    writeFileSync(join(root, 'b.txt'), 'post-move\n');
    store.append({
      path: 'b.txt',
      op: 'create',
      before: null,
      after: 'post-move\n',
      bytesDelta: 10,
      sessionId: 's1',
      toolCallId: 't2',
      timestamp: 3,
    });
    const plan = planUndo(store, { path: 'b.txt' }, root);
    expect(plan.headMoves).toEqual([]);
    const result = applyUndo(store, plan, root, {});
    expect(result.restored).toEqual(['b.txt']);
  });

  it('--step skips the marker and lands on the newest file entry', () => {
    const { store } = roots2();
    const plan = planUndo(store, { step: true });
    expect(plan.steps.map((s) => s.path)).toEqual(['a.txt']);
  });
});
