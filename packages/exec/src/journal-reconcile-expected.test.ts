// Issue #341 (§42.1 mechanism 2, §42.5): the sweep compares each path
// against its EXPECTED state — the last entry journaled during THIS run, or
// the boot baseline when there is none — never against the whole journal
// history. A same-run revert, a resumed session's change back to an older
// hash, and a repeat delete must all be journaled.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileJournalStore,
  type FileJournalStore as Store,
  sha256Hex,
} from './journal.js';
import { beginReconciliation } from './journal-reconcile.js';

const NOW = 1_700_000_000_000;
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

function begin(store: Store, root: string, runId: string) {
  return beginReconciliation({
    store,
    root,
    runId,
    sessionId: 'sess-1',
    agentId: 'root',
    now: () => NOW,
  });
}

function toolWrite(
  store: Store,
  path: string,
  before: string | null,
  after: string | null,
  timestamp = NOW,
): void {
  store.append({
    path,
    op: after === null ? 'delete' : before === null ? 'create' : 'write',
    before,
    after,
    bytesDelta: 0,
    sessionId: 'sess-1',
    agentId: 'root',
    toolCallId: 'tc-1',
    timestamp,
  });
}

describe('reconcile expected state (issue #341)', () => {
  it('journals a same-run out-of-band revert to the baseline content', () => {
    const root = tmpRoot('ws-341a-');
    const store = new FileJournalStore(tmpRoot('j-341a-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    const run = begin(store, root, 'run-1');
    // A tool writes H0 → H1 …
    writeFileSync(join(root, 'a.txt'), 'H1\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n');
    // … then `git checkout a.txt` restores H0 behind interception.
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.unattributed).toBe(true);
    expect(entry?.op).toBe('write');
    expect(entry?.beforeHash).toBe(sha256Hex('H1\n'));
    expect(entry?.afterHash).toBe(sha256Hex('H0\n'));
    // Idempotent afterwards.
    expect(run.sweep()).toBe(0);
  });

  it('journals a resumed-session change back to a prior run’s after-hash', () => {
    const root = tmpRoot('ws-341b-');
    const store = new FileJournalStore(tmpRoot('j-341b-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    // Run 1: a tool writes H.
    const run1 = begin(store, root, 'run-1');
    writeFileSync(join(root, 'a.txt'), 'H\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H\n');
    expect(run1.sweep()).toBe(0);
    // Between runs the user edits to H2.
    writeFileSync(join(root, 'a.txt'), 'H2\n');
    // Run 2 (same session journal): bash sets it back to H.
    const run2 = begin(store, root, 'run-2');
    writeFileSync(join(root, 'a.txt'), 'H\n');
    expect(run2.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.unattributed).toBe(true);
    expect(entry?.beforeHash).toBe(sha256Hex('H2\n'));
    expect(entry?.afterHash).toBe(sha256Hex('H\n'));
  });

  it('journals a run-2 delete of a file deleted in run 1 and recreated in between', () => {
    const root = tmpRoot('ws-341c-');
    const store = new FileJournalStore(tmpRoot('j-341c-'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const run1 = begin(store, root, 'run-1');
    rmSync(join(root, 'a.txt'));
    expect(run1.sweep()).toBe(1);
    expect(store.entries().at(-1)?.op).toBe('delete');
    // Recreated between runs.
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const run2 = begin(store, root, 'run-2');
    rmSync(join(root, 'a.txt'));
    expect(run2.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('v2\n'));
    expect(entry?.afterHash).toBe(null);
  });

  it('journals the out-of-band delete of a file a tool created this run', () => {
    const root = tmpRoot('ws-341d-');
    const store = new FileJournalStore(tmpRoot('j-341d-'));
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'made.txt'), 'new\n');
    toolWrite(store, 'made.txt', null, 'new\n');
    rmSync(join(root, 'made.txt'));
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('new\n'));
  });

  it('journals the out-of-band recreation of a file a tool deleted this run', () => {
    const root = tmpRoot('ws-341e-');
    const store = new FileJournalStore(tmpRoot('j-341e-'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const run = begin(store, root, 'run-1');
    rmSync(join(root, 'a.txt'));
    toolWrite(store, 'a.txt', 'v1\n', null);
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('create');
    expect(entry?.beforeHash).toBe(null);
    expect(entry?.afterHash).toBe(sha256Hex('v1\n'));
  });

  it('records nothing for a path whose last same-run entry matches the tree', () => {
    const root = tmpRoot('ws-341f-');
    const store = new FileJournalStore(tmpRoot('j-341f-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'a.txt'), 'H1\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n');
    expect(run.sweep()).toBe(0);
  });

  it('still scopes to this run when retention dropped older entries', () => {
    const root = tmpRoot('ws-341g-');
    const dir = tmpRoot('j-341g-');
    const store = new FileJournalStore(dir);
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    // Prior history in the journal (an older run's write to H1).
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n', NOW - 10_000);
    toolWrite(store, 'b.txt', null, 'x\n');
    const run = begin(store, root, 'run-2');
    // Retention drops the head entry mid-run: the boot marker (b.txt)
    // shifts from index 1 to 0.
    store.enforceRetention({ maxAgeMs: 5_000, now: NOW });
    expect(store.entries()).toHaveLength(1);
    toolWrite(store, 'c.txt', null, 'y\n');
    writeFileSync(join(root, 'c.txt'), 'y\n');
    // c.txt matches its same-run entry and a.txt its baseline: nothing new.
    expect(run.sweep()).toBe(0);
  });
});
