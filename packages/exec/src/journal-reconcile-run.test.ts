// Slice: run-scoped reconciliation lifecycle (issue #87; §42.1 mechanism 2,
// §42.5). The mechanism (captureBaseline/reconcile) landed in #17 but every
// caller was a test; this module is the wrapper the composition root calls:
// capture ONCE at lane boot, persist the hashes beside the session journal,
// sweep ONCE at run end.
// RED: packages/exec/src/journal-reconcile.ts does not exist yet.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore, loadBaseline, sha256Hex } from './journal.js';
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

function workspace(): string {
  const root = tmpRoot('ws-reconcile-');
  writeFileSync(join(root, 'keep.txt'), 'v1\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  writeFileSync(join(root, 'ignored.log'), 'noise\n');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  return root;
}

function journalStore(): FileJournalStore {
  return new FileJournalStore(tmpRoot('j-reconcile-'));
}

describe('run-scoped reconciliation lifecycle (issue #87)', () => {
  it('captures the baseline at boot and persists it beside the session journal', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    expect(run.baselinePath).toBe(
      join(dirname(store.indexPath), 'baseline-sess-1.json'),
    );
    expect(existsSync(run.baselinePath)).toBe(true);
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    // The persisted copy is the same map a later reader loads: the boot
    // capture is durable, not just in-memory.
    expect(loadBaseline(dirname(store.indexPath), 'sess-1')).toEqual(
      run.baseline,
    );
    expect(run.baseline['keep.txt']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sweeps after the last turn, recording unattributed entries with hashes only', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    // Whatever bypasses interception: an external writer, not a Kubic op.
    writeFileSync(join(root, 'keep.txt'), 'v2-external\n');
    writeFileSync(join(root, 'new.txt'), 'born\n');
    rmSync(join(root, 'gone.txt'));
    expect(run.sweep()).toBe(3);
    const entries = store.entries();
    expect(entries.every((e) => e.unattributed === true)).toBe(true);
    expect(entries.every((e) => e.toolCallId === null)).toBe(true);
    expect(entries.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(entries.every((e) => e.timestamp === NOW)).toBe(true);
    const changed = entries.find((e) => e.path === 'keep.txt');
    if (changed === undefined) throw new Error('missing keep.txt entry');
    expect(changed.beforeHash).toBe(sha256Hex('v1\n'));
    // Out of scope by design: before-content is unknowable for these, so
    // the entry carries the hash and no retrievable pre-image.
    expect(store.readBefore(changed)).toBe(null);
    expect(store.readAfter(changed)).toBe('v2-external\n');
    const created = entries.find((e) => e.path === 'new.txt');
    expect(created?.op).toBe('create');
    expect(created?.beforeHash).toBe(null);
    const deleted = entries.find((e) => e.path === 'gone.txt');
    expect(deleted?.op).toBe('delete');
    expect(deleted?.beforeHash).toBe(sha256Hex('bye\n'));
  });

  it('costs one metadata walk and zero blobs when nothing changed', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    // The capture stored hashes only: no before-blob, no after-blob.
    expect(store.blobCount()).toBe(0);
    expect(existsSync(join(dirname(store.indexPath), 'blobs'))).toBe(false);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toEqual([]);
  });

  it('excludes gitignored, out-of-scope and .kubic paths from both walks', () => {
    const root = workspace();
    mkdirSync(join(root, 'vendor'));
    writeFileSync(join(root, 'vendor', 'out.js'), 'gen\n');
    mkdirSync(join(root, '.kubic'));
    writeFileSync(join(root, '.kubic', 'state.json'), 'runtime\n');
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      outOfScope: ['vendor'],
      now: () => NOW,
    });
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    for (const rel of [
      'keep.txt',
      'ignored.log',
      ['vendor', 'out.js'],
      ['.kubic', 'state.json'],
    ]) {
      writeFileSync(
        join(root, ...(Array.isArray(rel) ? rel : [rel])),
        'mutated\n',
      );
    }
    expect(run.sweep()).toBe(1);
    expect(store.entries().map((e) => e.path)).toEqual(['keep.txt']);
  });

  it('refuses a path-unsafe run id before writing any baseline file', () => {
    const root = workspace();
    const store = journalStore();
    const dir = dirname(store.indexPath);
    expect(() =>
      beginReconciliation({
        store,
        root,
        runId: '../evil',
        sessionId: 'sess-1',
        agentId: 'root',
        now: () => NOW,
      }),
    ).toThrow(/invalid run id/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
  });

  it('adds nothing on a second sweep of an unchanged tree', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    writeFileSync(join(root, 'keep.txt'), 'v2\n');
    expect(run.sweep()).toBe(1);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  // A named pipe blocks `readFileSync` until a writer opens it, so capturing
  // a baseline over a workspace holding one wedges the run at boot forever —
  // not even a test timeout fires, because the block is synchronous. The walk
  // must treat a special file as "not journalable" and keep going.
  it('does not block on a named pipe in the workspace (regression)', () => {
    const root = tmpRoot('ws-fifo-');
    writeFileSync(join(root, 'keep.txt'), 'v1\n');
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const store = journalStore();
    const run = beginReconciliation({
      root,
      store,
      runId: 'sess-fifo',
      sessionId: 'sess-fifo',
      agentId: 'root',
      now: () => NOW,
    });
    // The regular file is journaled; the pipe is skipped, not read.
    expect(Object.keys(run.baseline)).toEqual(['keep.txt']);
  });

  // The docs used to promise unattributed entries are ALWAYS non-reversible
  // and exit 2. They are not: `readBefore` serves any entry whose `beforeHash`
  // resolves to a stored blob, and the sweep sets `beforeHash` from the
  // baseline. When an earlier tool entry in the same run already stored that
  // pre-image, undo CAN restore it — and must, rather than refusing.
  it('reports a sweep entry reversible when a pre-image was stored earlier (regression)', () => {
    const root = tmpRoot('ws-preimage-');
    writeFileSync(join(root, 'f.txt'), 'v1-boot\n');
    const store = journalStore();
    const run = beginReconciliation({
      root,
      store,
      runId: 'sess-pre',
      sessionId: 'sess-pre',
      agentId: 'root',
      now: () => NOW,
    });
    // The `write` tool rewrites it, storing the v1-boot pre-image.
    store.append({
      path: 'f.txt',
      op: 'write',
      before: 'v1-boot\n',
      after: 'v2-tool\n',
      bytesDelta: 0,
      sessionId: 'sess-pre',
      agentId: 'root',
      toolCallId: 't1',
      timestamp: NOW,
    });
    // An external writer changes it again; the sweep attributes that to nobody.
    writeFileSync(join(root, 'f.txt'), 'v3-external\n');
    expect(run.sweep()).toBe(1);
    const sweepEntry = store.entries().find((e) => e.unattributed === true);
    if (sweepEntry === undefined) throw new Error('missing sweep entry');
    // Issue #341: the before-side is the path's expected state — the tool's
    // after-content this run — not the boot baseline, so undo walks the
    // chain v3 → v2 (this entry) → v1 (the tool entry).
    expect(sweepEntry.beforeHash).toBe(sha256Hex('v2-tool\n'));
    // The pre-image resolves, so this entry is reversible in fact.
    expect(store.readBefore(sweepEntry)).toBe('v2-tool\n');
  });
});
